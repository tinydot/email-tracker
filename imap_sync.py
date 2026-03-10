#!/usr/bin/env python3
"""
imap_sync.py — Incrementally sync all folders from an IMAP account as .eml files.

No build step, no npm.  Only the standard library is required (imaplib, email, ssl).

Usage:
    python imap_sync.py --user you@outlook.com --output ./emails-export

Sync is *incremental*: a small JSON state file (imap_sync_state.json, created next to
the output folder) stores the IMAP UID of every message already downloaded.  On the next
run only new messages are fetched.  UIDVALIDITY is checked per-folder; if it ever
changes (mailbox rebuilt) that folder is re-synced from scratch.

All folders are flattened into a single output directory.  Folder name is embedded as
an  X-Original-Folder  header so smart-view rules in email-tracker can still filter by
it if needed.

Outlook.com settings (defaults):
    host : imap-mail.outlook.com
    port : 993  (SSL)

For Outlook.com you must use an App Password if your account has 2-step verification
enabled.  Generate one at: https://account.microsoft.com/security  → App passwords.
"""

import argparse
import getpass
import imaplib
import json
import os
import re
import ssl
import sys
import time
import email as email_lib
from email import policy as email_policy
from email.parser import BytesParser
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_HOST = "imap-mail.outlook.com"
DEFAULT_PORT = 993
STATE_FILENAME = "imap_sync_state.json"

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
            # Try unquoted name
            m = re.match(r'\(([^)]*)\)\s+\S+\s+(.+)$', decoded)
        if not m:
            continue
        flags_str = m.group(1).lower()
        name = m.group(2).strip().strip('"')
        # Skip non-selectable containers
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
    # Fallback: EXAMINE response may be in the last item
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

    # SELECT folder (read-only keeps \Seen flag untouched)
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
                folder_state["synced_uids"].append(uid)  # mark to avoid retrying corrupted msgs
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

            # Always mark as seen in state so we don't retry on next run
            folder_state["synced_uids"].append(uid)

        # Persist state after every batch so progress survives interruptions
        # (caller is responsible for calling save_state; we just mutate the dict)

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
        description="Incrementally sync an IMAP account to .eml files"
    )
    ap.add_argument("--user", required=True, help="IMAP login / email address")
    ap.add_argument(
        "--password",
        default=None,
        help="Password or app-password (omit to be prompted securely)",
    )
    ap.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"IMAP host  (default: {DEFAULT_HOST})",
    )
    ap.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"IMAP port  (default: {DEFAULT_PORT}, SSL)",
    )
    ap.add_argument(
        "--output",
        default="./emails-export",
        help="Output directory for .eml files  (default: ./emails-export)",
    )
    ap.add_argument(
        "--folders",
        nargs="*",
        default=None,
        metavar="FOLDER",
        help="Specific folders to sync (default: all folders)",
    )
    ap.add_argument(
        "--state-file",
        default=None,
        metavar="PATH",
        help=f"Path to state JSON file  (default: <output>/../{STATE_FILENAME})",
    )
    ap.add_argument(
        "--reset",
        action="store_true",
        help="Ignore saved state and re-sync everything from scratch",
    )
    ap.add_argument(
        "--batch-size",
        type=int,
        default=50,
        metavar="N",
        help="Messages fetched per IMAP batch  (default: 50)",
    )
    args = ap.parse_args()

    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    state_path = (
        Path(args.state_file).expanduser().resolve()
        if args.state_file
        else out_dir.parent / STATE_FILENAME
    )

    password = args.password or getpass.getpass(f"Password for {args.user}: ")

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

    print(f"Logging in as {args.user} …")
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
        # Persist state after each folder so a crash mid-run doesn't lose progress
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
