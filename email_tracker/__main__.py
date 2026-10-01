"""python -m email_tracker [serve | ingest PATH… | ingest-thunderbird | import-backup FILE | rederive |
                           backup | install-backup-job | install-server-job]"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

from . import config, launchd


def _store(cfg: config.Config):
    from .store import EmailStore
    return EmailStore(cfg.db_path, cfg.my_addresses)


def _print_result(label: str, res, t0: float) -> None:
    d = res.as_dict()
    errors = d.pop("errors")
    print(f"{label} in {time.monotonic() - t0:.1f}s: " + ", ".join(f"{k} {v}" for k, v in d.items()))
    for e in errors[:20]:
        print(f"  failed: {e}", file=sys.stderr)


def _ingest(cfg: config.Config, paths: list[Path]) -> int:
    from .ingest import Ingestor, ingest_paths
    store = _store(cfg)
    t0 = time.monotonic()
    res = ingest_paths(Ingestor(store, cfg.archive_dir), paths,
                       progress=lambda i, n, r: print(f"  {i:,}/{n:,}  added {r.added:,}", flush=True))
    _print_result("Ingested", res, t0)
    print("  now in database: " + ", ".join(f"{k} {v:,}" for k, v in store.counts().items()))
    store.close()
    return 1 if res.failed else 0


def _ingest_thunderbird(cfg: config.Config, profile: Path | None) -> int:
    from .ingest import Ingestor
    from .mbox import default_profile, scan_profile
    profile = profile or cfg.thunderbird_profile or default_profile()
    if not profile or not Path(profile).is_dir():
        sys.exit("No Thunderbird profile found; pass --profile or set thunderbird_profile in the config.")
    store = _store(cfg)
    t0 = time.monotonic()
    last = [0.0]

    def progress(folder, done, total, r):
        if time.monotonic() - last[0] > 2:
            last[0] = time.monotonic()
            print(f"  {100 * done // total:3d}%  {folder}  messages {r.messages:,}", flush=True)
    print(f"Scanning {profile}")
    res = scan_profile(Ingestor(store, cfg.archive_dir), Path(profile), progress)
    _print_result("Scanned", res, t0)
    store.close()
    return 0


def _import_backup(cfg: config.Config, path: Path) -> int:
    from .backup_json import apply_backup, read_text_chunks
    store = _store(cfg)
    t0 = time.monotonic()
    with open(path, "rb") as fh:
        res = apply_backup(store, read_text_chunks(fh))
    counts = store.counts()
    store.close()
    print(f"Imported {path} into {cfg.db_path} in {time.monotonic() - t0:.1f}s")
    print(f"  records in file: {res.total_records:,}  (emails skipped as existing/tombstoned: {res.emails_skipped:,})")
    for k, v in res.added.items():
        print(f"  added {k:<12} {v:>8,}")
    print("  now in database: " + ", ".join(f"{k} {v:,}" for k, v in counts.items()))
    if res.error:
        print(f"error: {res.error}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m email_tracker")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("serve", help="run the server on 127.0.0.1 (default)")
    g = sub.add_parser("ingest", help="ingest .eml files (files or folders, recursively)")
    g.add_argument("paths", type=Path, nargs="+")
    t = sub.add_parser("ingest-thunderbird", help="ingest a Thunderbird profile's mail folders")
    t.add_argument("--profile", type=Path, help="profile folder (default: config, then auto-detect)")
    sub.add_parser("rederive", help="recompute thread ids and needs_my_reply")
    i = sub.add_parser("import-backup", help="merge a v1 'Export JSON' backup into the database (skip-if-existing)")
    i.add_argument("file", type=Path)
    sub.add_parser("backup", help="snapshot the live database now (VACUUM INTO) and prune old ones")
    j = sub.add_parser("install-backup-job", help="install the nightly backup as a macOS LaunchAgent")
    j.add_argument("--print", action="store_true", help="show the plist instead of installing it")
    k = sub.add_parser("install-server-job", help="run the server at login (macOS LaunchAgent, KeepAlive)")
    k.add_argument("--print", action="store_true", help="show the plist instead of installing it")
    args = p.parse_args(argv)
    cfg = config.load()

    if args.cmd == "import-backup":
        return _import_backup(cfg, args.file)

    if args.cmd == "ingest":
        return _ingest(cfg, args.paths)

    if args.cmd == "ingest-thunderbird":
        return _ingest_thunderbird(cfg, args.profile)

    if args.cmd == "rederive":
        store = _store(cfg)
        store.rederive()
        n = store.con.execute("SELECT COUNT(*) FROM emails WHERE needs_my_reply = 1").fetchone()[0]
        print(f"Rederived: {store.counts()['threaded']:,} replies threaded, {n:,} threads need a reply"
              + ("" if cfg.my_addresses else " (my_addresses is not set in the config)"))
        store.close()
        return 0

    if args.cmd == "backup":
        from . import backup
        print(backup.run(cfg.db_path, cfg.backup_dir))
        return 0

    if args.cmd == "install-backup-job":
        from . import backup
        uv = shutil.which("uv")
        if not uv:
            sys.exit("uv not found on PATH; the job runs `uv run`.")
        log = Path("~/Library/Logs/email-tracker-backup.log").expanduser()
        plist = backup.launchd_plist(uv, config.REPO_ROOT, log)
        if args.print:
            print(plist)
            return 0
        dest = launchd.install(backup.LABEL, plist)
        print(f"Installed {dest}: nightly at 02:45 (runs on wake if missed); log {log}")
        return 0

    if args.cmd == "install-server-job":
        uv = shutil.which("uv")
        if not uv:
            sys.exit("uv not found on PATH; the job runs `uv run`.")
        log = Path("~/Library/Logs/email-tracker-server.log").expanduser()
        plist = launchd.server_plist(uv, config.REPO_ROOT, log)
        if args.print:
            print(plist)
            return 0
        dest = launchd.install(launchd.SERVER_LABEL, plist)
        print(f"Installed {dest}: http://127.0.0.1:{cfg.port} at login, restarted if it exits; log {log}")
        return 0

    import uvicorn
    from .server import create_app
    print(f"email-tracker v2: http://127.0.0.1:{cfg.port}  (db: {cfg.db_path})")
    # Loopback only, always: Tailscale Serve proxies to it later.
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=cfg.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
