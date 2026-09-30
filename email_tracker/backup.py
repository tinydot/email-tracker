"""Nightly snapshots of the live database (adapted from bank-consolidator v2).

v1 kept its data in the browser, with Google Drive backups on top; v2 has one
file, so it gets snapshots before it becomes the daily driver. Litestream
replaces this on the Mac mini (life-mcp HANDOVER, Phase 3).

``VACUUM INTO`` writes a compact, consistent copy through a read-only
connection, so it is safe while the server is running (the server stays the
file's only writer). Each snapshot is checked and written under a temporary
name first, so a crash mid-backup never leaves a half-written file that looks
like a good one.

Retention: every snapshot from the last ``KEEP_DAILY`` days, plus the first
snapshot of each of the last ``KEEP_MONTHLY`` months.

Restore: stop the server, then copy the snapshot over the live db_path (and
delete any ``-wal``/``-shm`` beside it).
"""
from __future__ import annotations

import os
import re
import sqlite3
from datetime import date
from pathlib import Path

KEEP_DAILY = 14
KEEP_MONTHLY = 12
_NAME = re.compile(r"^email-(\d{4}-\d{2}-\d{2})\.db$")
REQUIRED_TABLES = {"emails", "bodies", "attachments", "seen_ids", "settings"}


def default_dir(db_path: Path) -> Path:
    return db_path.parent / "backups"


def verify(path: Path) -> None:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if con.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError(f"{path}: quick_check failed")
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        missing = REQUIRED_TABLES - tables
        if missing:
            raise ValueError(f"{path}: missing tables {sorted(missing)}")
    finally:
        con.close()


def snapshot(db_path: Path, backup_dir: Path, today: date | None = None) -> Path:
    """Write and verify ``email-YYYY-MM-DD.db``; returns its path."""
    today = today or date.today()
    if not db_path.exists():
        raise FileNotFoundError(f"no live database at {db_path}")
    backup_dir.mkdir(parents=True, exist_ok=True)
    final = backup_dir / f"email-{today.isoformat()}.db"
    tmp = backup_dir / f".{final.name}.partial"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    try:
        con.execute("VACUUM INTO ?", (str(tmp),))
    finally:
        con.close()
    try:
        verify(tmp)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, final)
    return final


def prune(backup_dir: Path, today: date | None = None) -> list[Path]:
    """Delete snapshots outside the retention window; returns what was removed."""
    today = today or date.today()
    dated = sorted((date.fromisoformat(m.group(1)), p)
                   for p in backup_dir.glob("email-*.db") if (m := _NAME.match(p.name)))
    keep: set[Path] = set()
    for d, p in dated:
        if (today - d).days < KEEP_DAILY:
            keep.add(p)
    months_seen: set[tuple[int, int]] = set()
    for d, p in dated:  # oldest first, so this keeps each month's first snapshot
        months_back = (today.year - d.year) * 12 + (today.month - d.month)
        if months_back < KEEP_MONTHLY and (d.year, d.month) not in months_seen:
            months_seen.add((d.year, d.month))
            keep.add(p)
    removed = [p for _, p in dated if p not in keep]
    for p in removed:
        p.unlink()
    return removed


def run(db_path: Path, backup_dir: Path | None = None) -> str:
    backup_dir = backup_dir or default_dir(db_path)
    path = snapshot(db_path, backup_dir)
    removed = prune(backup_dir)
    kept = len(list(backup_dir.glob("email-*.db")))
    return (f"snapshot {path} ({path.stat().st_size:,} bytes, verified); "
            f"{kept} kept, {len(removed)} pruned")


# ── launchd (macOS) ─────────────────────────────────────────────────────────

LABEL = "com.email-tracker.backup"


def launchd_plist(uv: str, repo: Path, log: Path, hour: int = 2, minute: int = 45) -> str:
    """A LaunchAgent that runs the backup nightly (a run missed while the Mac
    slept fires on wake). 02:45, clear of bank-consolidator's 02:30."""
    args = [uv, "--directory", str(repo), "run", "python", "-m", "email_tracker", "backup"]
    items = "\n".join(f"        <string>{a}</string>" for a in args)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
{items}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>{hour}</integer>
        <key>Minute</key>
        <integer>{minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"""
