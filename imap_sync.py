#!/usr/bin/env python3
"""
imap_sync.py — Incrementally sync all folders from an IMAP account as .eml files.

Standard library only for basic auth.  OAuth2 requires one extra package:
    pip install msal

Usage — basic auth (App Password):
    python imap_sync.py --user you@outlook.com --output ./emails-export

Usage — OAuth2 / Modern Auth (company Exchange / Office 365):
    python imap_sync.py --user you@company.com --auth oauth2 \\
        --client-id <azure-app-client-id> --output ./emails-export

Sync is *incremental*: a small JSON state file (imap_sync_state.json, created next to
the output folder) stores the IMAP UID of every message already downloaded.  On the next
run only new messages are fetched.  UIDVALIDITY is checked per-folder; if it ever
changes (mailbox rebuilt) that folder is re-synced from scratch.

All folders are flattened into a single output directory.  Folder name is embedded as
an  X-Original-Folder  header so smart-view rules in email-tracker can still filter by
it if needed.

Default IMAP host / port: imap-mail.outlook.com:993 (SSL)
For Office 365 work accounts use:  --host outlook.office365.com
"""

import argparse
import base64
import getpass
import imaplib
import json
import os
import re
import ssl
import sys
import email as email_lib
from email import policy as email_policy
from email.parser import BytesParser
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_HOST = "imap-mail.outlook.com"
DEFAULT_PORT = 993
STATE_FILENAME = "imap_sync_state.json"
TOKEN_CACHE_FILENAME = "imap_sync_token_cache.json"

# Microsoft OAuth2 — IMAP delegated permission scope
OAUTH2_SCOPES = ["https://outlook.office.com/IMAP.AccessAsUser.All"]

# ── Helpers ───────────────────────────────────────────────────────────────────


def sanitize(name: str, max_len: int = 60) -> str:
    """Make a string safe for use as a filename component."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "no-subject")
    return name[:max_len].strip() or "no-subject"


def load_state(state_path: Path) -> dict:
    """Load sync state from JSON; return empty dict if file doesn't exist."""
    if state_path.exists():
        try:
            with state_path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state_path: Path, state: dict) -> None:
    """Persist sync state atomically."""
    tmp = state_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    tmp.replace(state_path)


def imap_connect(host: str, port: int) -> imaplib.IMAP4_SSL:
    """Open an SSL connection to the IMAP server."""
    ctx = ssl.create_default_context()
    return imaplib.IMAP4_SSL(host, port, ssl_context=ctx)


def list_folders(M: imaplib.IMAP4_SSL) -> list[str]:
    """
    Return a flat list of all selectable folder names on the server.
    Non-selectable folders (e.g. namespace parents) are skipped.
    """
    _, lines = M.list()
    folders = []
    for line in lines:
        if not line:
            continue
        decoded = line.decode("utf-8", errors="replace")
        # IMAP LIST response: (\Flags) "delimiter" "name"
        m = re.match(r'\(([^)]*)\)\s+"[^"]*"\s+"?([^"]+)"?', decoded)
        if not m:
            m = re.match(r'\(([^)]*)\)\s+\S+\s+(.+)$', decoded)
        if not m:
            continue
        flags_str = m.group(1).lower()
        name = m.group(2).strip().strip('"')
        if r"\noselect" in flags_str:
            continue
        folders.append(name)
    return folders


def fetch_uid_validity(M: imaplib.IMAP4_SSL, folder: str) -> int | None:
    """SELECT a folder and return its UIDVALIDITY value."""
    status, data = M.select(f'"{folder}"', readonly=True)
    if status != "OK":
        return None
    for item in data:
        if item and isinstance(item, bytes):
            m = re.search(rb"\[UIDVALIDITY (\d+)\]", item)
            if m:
                return int(m.group(1))
    _, resp = M.response("UIDVALIDITY")
    if resp and resp[0]:
        try:
            return int(resp[0])
        except (ValueError, TypeError):
            pass
    return None


def fetch_all_uids(M: imaplib.IMAP4_SSL) -> list[int]:
    """Return sorted list of all UIDs in the currently selected folder."""
    status, data = M.uid("search", None, "ALL")
    if status != "OK" or not data[0]:
        return []
    return sorted(int(u) for u in data[0].split())


def fetch_message(M: imaplib.IMAP4_SSL, uid: int) -> bytes | None:
    """Fetch the raw RFC 822 bytes for a single message by UID."""
    status, data = M.uid("fetch", str(uid), "(RFC822)")
    if status != "OK":
        return None
    for part in data:
        if isinstance(part, tuple) and len(part) == 2:
            return part[1]
    return None


def inject_folder_header(raw: bytes, folder: str) -> bytes:
    """
    Prepend an  X-Original-Folder  header to the raw message bytes so that
    email-tracker smart-view rules can filter by source folder.
    """
    header_line = f"X-Original-Folder: {folder}\r\n".encode()
    return header_line + raw


# ── OAuth2 / Modern Auth ──────────────────────────────────────────────────────


def _load_token_cache(cache_path: Path):
    """Load a serializable MSAL token cache from disk (or return empty cache)."""
    try:
        import msal
    except ImportError:
        sys.exit(
            "OAuth2 requires the 'msal' package.\n"
            "Install it with:  pip install msal"
        )
    cache = msal.SerializableTokenCache()
    if cache_path.exists():
        try:
            cache.deserialize(cache_path.read_text(encoding="utf-8"))
        except Exception:
            pass  # corrupt cache — start fresh
    return cache


def _save_token_cache(cache, cache_path: Path) -> None:
    """Write the MSAL token cache to disk if it changed."""
    if cache.has_state_changed:
        cache_path.write_text(cache.serialize(), encoding="utf-8")


def get_oauth2_token(
    user: str,
    client_id: str,
    tenant: str,
    cache_path: Path,
) -> str:
    """
    Acquire a Microsoft OAuth2 access token for IMAP using the Device Code flow.

    On the first run the user visits a short URL and enters a one-time code.
    Subsequent runs reuse the cached refresh token silently — no browser needed.

    Returns the Bearer access token string.
    """
    try:
        import msal
    except ImportError:
        sys.exit(
            "OAuth2 requires the 'msal' package.\n"
            "Install it with:  pip install msal"
        )

    authority = f"https://login.microsoftonline.com/{tenant}"
    cache = _load_token_cache(cache_path)

    app = msal.PublicClientApplication(
        client_id,
        authority=authority,
        token_cache=cache,
    )

    # Try silent acquisition first (uses cached refresh token)
    accounts = app.get_accounts(username=user)
    if accounts:
        result = app.acquire_token_silent(OAUTH2_SCOPES, account=accounts[0])
        if result and "access_token" in result:
            _save_token_cache(cache, cache_path)
            print("  (using cached token — no login required)")
            return result["access_token"]

    # Interactive: Device Code flow (works in terminals, no browser redirect needed)
    flow = app.initiate_device_flow(scopes=OAUTH2_SCOPES)
    if "user_code" not in flow:
        sys.exit(f"Failed to start device flow: {flow.get('error_description', flow)}")

    # Print the one-time-use message from Microsoft (contains URL + code)
    print()
    print("─" * 60)
    print(flow["message"])
    print("─" * 60)
    print("Waiting for authentication …")

    result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        err = result.get("error_description") or result.get("error") or str(result)
        sys.exit(f"OAuth2 authentication failed: {err}")

    _save_token_cache(cache, cache_path)
    print("Authentication successful.\n")
    return result["access_token"]


def login_oauth2(M: imaplib.IMAP4_SSL, user: str, access_token: str) -> None:
    """
    Authenticate an already-connected IMAP session using XOAUTH2 (RFC 7628).

    The XOAUTH2 SASL string format is:
        "user=<email>\\x01auth=Bearer <token>\\x01\\x01"
    base64-encoded and passed as a single AUTHENTICATE XOAUTH2 argument.
    """
    auth_string = f"user={user}\x01auth=Bearer {access_token}\x01\x01"
    auth_bytes = base64.b64encode(auth_string.encode())

    # imaplib.authenticate passes the server challenge to the callback;
    # for XOAUTH2 the client speaks first so we ignore the challenge.
    try:
        M.authenticate("XOAUTH2", lambda _: auth_bytes)
    except imaplib.IMAP4.error as exc:
        # Microsoft returns a base64-encoded JSON error on failure — decode it
        raw = str(exc)
        try:
            decoded = base64.b64decode(raw.split()[-1]).decode()
            sys.exit(f"XOAUTH2 login failed: {decoded}")
        except Exception:
            sys.exit(f"XOAUTH2 login failed: {exc}")


# ── Core sync logic ───────────────────────────────────────────────────────────


def sync_folder(
    M: imaplib.IMAP4_SSL,
    folder: str,
    out_dir: Path,
    account_state: dict,
    batch_size: int = 50,
) -> tuple[int, int]:
    """
    Sync one IMAP folder.

    Returns (new_count, error_count).
    account_state is mutated in place and should be persisted by the caller.
    """
    folder_state = account_state.setdefault(folder, {"uidvalidity": None, "synced_uids": []})

    # SELECT folder (read-only keeps \\Seen flag untouched)
    status, _ = M.select(f'"{folder}"', readonly=True)
    if status != "OK":
        print(f"  [skip] Cannot SELECT '{folder}' — {status}")
        return 0, 0

    # Check UIDVALIDITY
    uid_validity = fetch_uid_validity(M, folder)
    if uid_validity is not None:
        stored = folder_state.get("uidvalidity")
        if stored is not None and stored != uid_validity:
            print(f"  [reset] UIDVALIDITY changed for '{folder}' — re-syncing all")
            folder_state["synced_uids"] = []
        folder_state["uidvalidity"] = uid_validity

    all_uids = fetch_all_uids(M)
    synced_set = set(folder_state["synced_uids"])
    new_uids = [u for u in all_uids if u not in synced_set]

    total_new = len(new_uids)
    if total_new == 0:
        print(f"  '{folder}' — up to date ({len(all_uids)} messages)")
        return 0, 0

    print(f"  '{folder}' — {total_new} new message(s) to download …")

    saved = errors = 0

    for batch_start in range(0, total_new, batch_size):
        batch = new_uids[batch_start : batch_start + batch_size]

        for uid in batch:
            raw = fetch_message(M, uid)
            if raw is None:
                errors += 1
                folder_state["synced_uids"].append(uid)  # avoid retrying corrupted msgs
                continue

            # Parse subject for a human-readable filename
            try:
                msg = BytesParser(policy=email_policy.compat32).parsebytes(raw)
                subject = msg.get("Subject", "") or ""
                decoded_subject = email_lib.header.decode_header(subject)
                subject_parts = []
                for part, charset in decoded_subject:
                    if isinstance(part, bytes):
                        subject_parts.append(part.decode(charset or "utf-8", errors="replace"))
                    else:
                        subject_parts.append(str(part))
                subject = " ".join(subject_parts).strip()
            except Exception:
                subject = ""

            safe_subject = sanitize(subject)
            safe_folder = sanitize(folder, max_len=30)
            filename = f"{safe_folder}_{uid}_{safe_subject}.eml"
            filepath = out_dir / filename
            if len(str(filepath)) > 240:
                filepath = out_dir / f"{safe_folder}_{uid}.eml"

            try:
                patched = inject_folder_header(raw, folder)
                with filepath.open("wb") as fh:
                    fh.write(patched)
                saved += 1
            except OSError as exc:
                print(f"    [error] UID {uid}: {exc}")
                errors += 1

            folder_state["synced_uids"].append(uid)

        done = min(batch_start + batch_size, total_new)
        print(f"    {done}/{total_new} processed ({saved} saved, {errors} failed)\r", end="", flush=True)

    label = f"    {saved:4d} saved"
    if errors:
        label += f", {errors} failed"
    print(label + " " * 20)
    return saved, errors


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Incrementally sync an IMAP account to .eml files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic auth (App Password)
  python imap_sync.py --user you@outlook.com --output ./emails-export

  # OAuth2 / Modern Auth (company Exchange / Office 365)
  python imap_sync.py --user you@company.com --auth oauth2 \\
      --client-id 00000000-0000-0000-0000-000000000000 --output ./emails-export

  # Office 365 work account with specific tenant
  python imap_sync.py --user you@company.com --auth oauth2 \\
      --client-id <id> --tenant <tenant-id> \\
      --host outlook.office365.com --output ./emails-export
""",
    )

    # ── Auth ──────────────────────────────────────────────────────────────────
    auth_group = ap.add_argument_group("authentication")
    auth_group.add_argument(
        "--auth",
        choices=["basic", "oauth2"],
        default="basic",
        help="Authentication method: 'basic' (password/app-password) or 'oauth2' (Modern Auth).  default: basic",
    )
    auth_group.add_argument("--user", required=True, help="Email address / IMAP login")
    auth_group.add_argument(
        "--password",
        default=None,
        help="Password or app-password for --auth basic (omit to be prompted securely)",
    )
    auth_group.add_argument(
        "--client-id",
        default=None,
        metavar="UUID",
        help="Azure app registration Client ID — required for --auth oauth2",
    )
    auth_group.add_argument(
        "--tenant",
        default="common",
        metavar="TENANT",
        help="Azure tenant ID, 'common', 'organizations', or 'consumers'.  default: common",
    )
    auth_group.add_argument(
        "--token-cache",
        default=None,
        metavar="PATH",
        help=f"Path to OAuth2 token cache file  (default: <output>/../{TOKEN_CACHE_FILENAME})",
    )

    # ── Connection ────────────────────────────────────────────────────────────
    conn_group = ap.add_argument_group("connection")
    conn_group.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"IMAP host  (default: {DEFAULT_HOST})",
    )
    conn_group.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"IMAP port  (default: {DEFAULT_PORT}, SSL)",
    )

    # ── Sync ──────────────────────────────────────────────────────────────────
    sync_group = ap.add_argument_group("sync")
    sync_group.add_argument(
        "--output",
        default="./emails-export",
        help="Output directory for .eml files  (default: ./emails-export)",
    )
    sync_group.add_argument(
        "--folders",
        nargs="*",
        default=None,
        metavar="FOLDER",
        help="Specific folders to sync (default: all folders)",
    )
    sync_group.add_argument(
        "--state-file",
        default=None,
        metavar="PATH",
        help=f"Path to sync state JSON file  (default: <output>/../{STATE_FILENAME})",
    )
    sync_group.add_argument(
        "--reset",
        action="store_true",
        help="Ignore saved state and re-sync everything from scratch",
    )
    sync_group.add_argument(
        "--batch-size",
        type=int,
        default=50,
        metavar="N",
        help="Messages fetched per IMAP round-trip  (default: 50)",
    )

    args = ap.parse_args()

    # ── Validate arg combos ───────────────────────────────────────────────────
    if args.auth == "oauth2" and not args.client_id:
        ap.error("--auth oauth2 requires --client-id <azure-app-client-id>")

    # ── Paths ─────────────────────────────────────────────────────────────────
    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    state_path = (
        Path(args.state_file).expanduser().resolve()
        if args.state_file
        else out_dir.parent / STATE_FILENAME
    )

    token_cache_path = (
        Path(args.token_cache).expanduser().resolve()
        if args.token_cache
        else out_dir.parent / TOKEN_CACHE_FILENAME
    )

    # ── Load / reset state ────────────────────────────────────────────────────
    state = {} if args.reset else load_state(state_path)
    account_state = state.setdefault(args.user, {})
    if args.reset:
        print("--reset: clearing saved state, will re-download all messages.")

    # ── Connect ───────────────────────────────────────────────────────────────
    print(f"Connecting to {args.host}:{args.port} …")
    try:
        M = imap_connect(args.host, args.port)
    except (OSError, ssl.SSLError) as exc:
        sys.exit(f"Connection failed: {exc}")

    # ── Authenticate ──────────────────────────────────────────────────────────
    print(f"Logging in as {args.user} ({args.auth}) …")

    if args.auth == "oauth2":
        token = get_oauth2_token(
            user=args.user,
            client_id=args.client_id,
            tenant=args.tenant,
            cache_path=token_cache_path,
        )
        login_oauth2(M, args.user, token)
    else:
        password = args.password or getpass.getpass(f"Password for {args.user}: ")
        try:
            M.login(args.user, password)
        except imaplib.IMAP4.error as exc:
            sys.exit(f"Login failed: {exc}")

    # ── Discover folders ──────────────────────────────────────────────────────
    if args.folders:
        folders = args.folders
        print(f"Syncing {len(folders)} specified folder(s).")
    else:
        print("Listing folders …")
        folders = list_folders(M)
        print(f"Found {len(folders)} folder(s).")

    if not folders:
        print("No folders to sync.")
        M.logout()
        return

    # ── Sync each folder ──────────────────────────────────────────────────────
    print(f"Output directory: {out_dir}\n")
    total_saved = total_errors = 0

    for folder in folders:
        saved, errors = sync_folder(
            M, folder, out_dir, account_state,
            batch_size=args.batch_size,
        )
        total_saved += saved
        total_errors += errors
        save_state(state_path, state)

    M.logout()

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'─' * 50}")
    print(f"Done — {total_saved} new email(s) downloaded.", end="")
    if total_errors:
        print(f"  ({total_errors} error(s))", end="")
    print()
    print(f"State saved to:  {state_path}")
    print(f"Drop  '{out_dir}'  into the email-tracker import panel.")


if __name__ == "__main__":
    main()
