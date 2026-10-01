"""Thunderbird profiles as a mail source — the server side of v1's
``handleThunderbirdFiles`` (js/import.js).

Each Thunderbird folder is one mbox file with a sibling ``.msf`` index. The
server reads the profile directly: Chrome's File System Access blocklist on
``~/Library`` (why v1 needed ``<input webkitdirectory>``) doesn't apply here.

Same rules as v1: a separator is ``From `` at the start of the file or right
after a blank line; messages Thunderbird has flagged expunged in
``X-Mozilla-Status`` (deleted but not yet compacted away) and folders matching
``SKIP_FOLDERS`` are skipped. Files are memory-mapped, so a multi-GB folder is
never read into memory.

Re-scans are cheap: a message whose Message-ID is already in the database (with
its raw file archived) is skipped from a header peek without parsing, and a
folder that has only grown since the last scan (the mbox was appended to)
resumes from where that scan ended. Anything else — a compacted folder — is
rescanned from the top, still skipping what's known.
"""
from __future__ import annotations

import configparser
import json
import mmap
import os
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

from .ingest import Batch, IngestResult, Ingestor
from .parse import _raw_header, clean_msg_id

SKIP_FOLDERS = re.compile(r"^(trash|junk|spam|drafts|templates|outbox|unsent messages|deleted items|"
                          r"deleted messages|junk e-?mail)$", re.I)
MOZ_STATUS_EXPUNGED = 0x0008
_SEPARATOR = re.compile(rb"(?:\A|\n\r?\n)From ")
_HEADER_END = re.compile(rb"\r?\n\r?\n")
STATE_KEY = "mbox_state"
TB_ROOT = Path("~/Library/Thunderbird").expanduser()


def default_profile(root: Path = TB_ROOT) -> Path | None:
    """The profile Thunderbird itself opens: profiles.ini's [Install…] Default,
    else the one marked Default=1, else the largest."""
    ini = root / "profiles.ini"
    if ini.exists():
        cp = configparser.ConfigParser()
        cp.read(ini)
        for sec in cp.sections():
            if sec.startswith("Install") and cp[sec].get("Default"):
                p = root / cp[sec]["Default"]
                if p.is_dir():
                    return p
        for sec in cp.sections():
            if sec.startswith("Profile") and cp[sec].get("Default") == "1" and cp[sec].get("Path"):
                p = root / cp[sec]["Path"] if cp[sec].get("IsRelative", "1") == "1" else Path(cp[sec]["Path"])
                if (p / "Mail").is_dir() or (p / "ImapMail").is_dir():
                    return p
    profiles = root / "Profiles"
    cands = [p for p in profiles.glob("*") if (p / "Mail").is_dir() or (p / "ImapMail").is_dir()] \
        if profiles.is_dir() else []
    return max(cands, key=lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()), default=None)


@dataclass
class MboxFolder:
    path: Path
    label: str     # "outlook.office365.com/Thunderbird/Sep 3"


def find_mbox_files(root: Path) -> list[MboxFolder]:
    """mbox files under ``root``: a file with a sibling ``<name>.msf``, or ``*.mbox``."""
    out = []
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix == ".msf" or f.stat().st_size == 0:
            continue
        if not f.with_name(f.name + ".msf").exists() and f.suffix.lower() != ".mbox":
            continue
        try:
            rel = f.relative_to(root)
        except ValueError:
            rel = Path(f.name)
        parts = [p[:-4] if p.endswith(".sbd") else p for p in rel.parts]
        if parts and parts[0] in ("Mail", "ImapMail"):
            parts = parts[1:]
        out.append(MboxFolder(f, "/".join(parts)))
    return out


def iter_messages(mm: mmap.mmap | bytes, start: int = 0) -> Iterator[tuple[int, int]]:
    """(start, end) byte ranges of each message, separator line included."""
    offsets = []
    for m in _SEPARATOR.finditer(mm, start):
        offsets.append(m.end() - 5)
    if start == 0 and (not offsets or offsets[0] != 0) and bytes(mm[:5]) == b"From ":
        offsets.insert(0, 0)
    for i, off in enumerate(offsets):
        yield off, offsets[i + 1] if i + 1 < len(offsets) else len(mm)


def peek(chunk: bytes) -> dict[str, str]:
    """The few headers a scan needs, from the first KBs of a message."""
    m = _HEADER_END.search(chunk)
    head = chunk[:m.start()] if m else chunk
    out: dict[str, str] = {}
    cur = None
    for line in head.decode("ascii", "surrogateescape").splitlines():
        if line[:1] in (" ", "\t") and cur:
            out[cur] += " " + line.strip()
            continue
        name, sep, val = line.partition(":")
        if not sep:
            continue
        cur = name.strip().lower()
        if cur in ("message-id", "x-mozilla-status", "subject") and cur not in out:
            out[cur] = val.strip()
        else:
            cur = cur if cur in out else None
    return out


def _load_state(ing: Ingestor) -> dict:
    raw = ing.store.meta(STATE_KEY)
    return json.loads(raw) if raw else {}


def _save_state(ing: Ingestor, state: dict) -> None:
    with ing.store.tx() as con:
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                    (STATE_KEY, json.dumps(state)))


@dataclass
class ScanResult(IngestResult):
    folders: int = 0
    skipped_folders: list[str] | None = None
    expunged: int = 0
    messages: int = 0

    def as_dict(self) -> dict:
        d = super().as_dict()
        d.update(folders=self.folders, skippedFolders=self.skipped_folders or [],
                 expunged=self.expunged, messages=self.messages)
        return d

    def take_counts(self, other: IngestResult) -> None:
        for k in ("added", "existing", "tombstoned", "archived", "failed"):
            setattr(self, k, getattr(other, k))
        self.errors = list(other.errors)
        self.added_ids = list(other.added_ids)


def scan_profile(ing: Ingestor, profile: Path,
                 progress: Callable[[str, int, int, ScanResult], None] | None = None) -> ScanResult:
    """Ingest every message in the profile's mail folders."""
    folders = find_mbox_files(Path(profile))
    res = ScanResult(skipped_folders=[])
    state = _load_state(ing)
    total = sum(f.path.stat().st_size for f in folders) or 1
    done_bytes = 0
    with ing.batch() as batch:
        for folder in folders:
            size = folder.path.stat().st_size
            if SKIP_FOLDERS.match(folder.path.name):
                res.skipped_folders.append(folder.label)
                done_bytes += size
                continue
            res.folders += 1
            key = str(folder.path)
            prev = state.get(key) or {}
            with open(folder.path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                start = 0
                # Resume only when the folder has just grown and the old end is
                # still a message boundary; a compaction invalidates the offset.
                if prev and size >= prev.get("size", 0) and 0 < prev.get("end", 0) <= size:
                    e = prev["end"]
                    if mm[e:e + 5] == b"From " or e == size:
                        start = max(0, e - 3)  # let the separator regex see its blank line
                for s, e in iter_messages(mm, start):
                    _one(batch, res, mm, s, e, folder)
                    if progress and res.messages % 250 == 0:
                        res.take_counts(batch.result)
                        progress(folder.label, done_bytes + e, total, res)
            state[key] = {"size": size, "end": size, "mtime": os.path.getmtime(folder.path)}
            done_bytes += size
            if progress:
                res.take_counts(batch.result)
                progress(folder.label, done_bytes, total, res)
        # checkpoint the state only once this batch's messages are committed
        batch._commit()
        _save_state(ing, state)
    res.take_counts(batch.result)
    return res


def _one(batch: Batch, res: ScanResult, mm, start: int, end: int, folder: MboxFolder) -> None:
    nl = mm.find(b"\n", start, end)
    if nl == -1 or nl + 1 >= end:
        return
    body_start = nl + 1
    res.messages += 1
    head = peek(bytes(mm[body_start:min(end, body_start + 16384)]))
    try:
        status = int(head.get("x-mozilla-status", "0") or "0", 16)
    except ValueError:
        status = 0
    if status & MOZ_STATUS_EXPUNGED:
        res.expunged += 1
        return
    mid = clean_msg_id(head.get("message-id", ""))
    if mid:
        known = batch.known(mid)
        if known == "tombstoned":
            batch.result.tombstoned += 1
            return
        if known == "settled":
            batch.result.existing += 1
            return
    subject = _raw_header(head.get("subject", "")) or "message"
    batch.add(bytes(mm[body_start:end]), f"{subject[:120]}.eml")
