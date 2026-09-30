"""python -m email_tracker [serve | import-backup FILE | backup | install-backup-job]"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import config


def _import_backup(cfg: config.Config, path: Path) -> int:
    from .backup_json import apply_backup, read_text_chunks
    from .store import EmailStore
    store = EmailStore(cfg.db_path)
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
    i = sub.add_parser("import-backup", help="merge a v1 'Export JSON' backup into the database (skip-if-existing)")
    i.add_argument("file", type=Path)
    sub.add_parser("backup", help="snapshot the live database now (VACUUM INTO) and prune old ones")
    j = sub.add_parser("install-backup-job", help="install the nightly backup as a macOS LaunchAgent")
    j.add_argument("--print", action="store_true", help="show the plist instead of installing it")
    args = p.parse_args(argv)
    cfg = config.load()

    if args.cmd == "import-backup":
        return _import_backup(cfg, args.file)

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
        dest = Path(f"~/Library/LaunchAgents/{backup.LABEL}.plist").expanduser()
        dest.write_text(plist)
        domain = f"gui/{os.getuid()}"
        subprocess.run(["launchctl", "bootout", f"{domain}/{backup.LABEL}"], capture_output=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(dest)], check=True)
        print(f"Installed {dest}: nightly at 02:45 (runs on wake if missed); log {log}")
        return 0

    import uvicorn
    from .server import create_app
    print(f"email-tracker v2: http://127.0.0.1:{cfg.port}  (db: {cfg.db_path})")
    # Loopback only, always: Tailscale Serve proxies to it later.
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=cfg.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
