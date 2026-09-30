"""Ingest raw messages into email.db — the v2 replacement for js/import.js.

One path for every source: an uploaded .eml, a folder of them, or a message
cut out of a Thunderbird mbox (mbox.py) all arrive here as raw bytes plus a
file name.

- Idempotent: an id already present (or tombstoned) is skipped, never
  re-written, so tags, status and edits survive any re-import. The one thing
  a re-import adds to an existing email is its raw file, if the archive
  didn't have it (emails that came over from v1's JSON backup have none).
- The raw bytes are archived under ``<archive_dir>/<sender domain>/<name>``
  (v1's layout), so the original can be served and re-parsed later.
- Derived state (threads, needs_my_reply) is recomputed once per batch, not
  per message: ``Batch.close()`` does it, and an interrupted batch leaves
  ``derive_pending`` set so the next start finishes the job.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .clean import CleanRules, clean_body
from .detect import DetectRules, is_system_email
from .parse import ParsedAttachment, email_id, parse_message, peek_headers
from .store import EmailStore

BATCH_COMMIT = 200  # messages per transaction


def _now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _domain_dir(from_addr: str) -> str:
    domain = from_addr.split("@", 1)[1] if "@" in from_addr else "unknown"
    return re.sub(r"[^a-zA-Z0-9.-]", "_", domain).strip("_") or "unknown"


def _safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().strip(".") or "message"
    if not name.lower().endswith(".eml"):
        name += ".eml"
    stem = name[:-4]
    return stem[:150] + ".eml"


@dataclass
class IngestResult:
    added: int = 0
    existing: int = 0
    tombstoned: int = 0
    archived: int = 0      # raw files newly archived for emails already present
    failed: int = 0
    errors: list[str] = field(default_factory=list)
    added_ids: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"added": self.added, "existing": self.existing, "tombstoned": self.tombstoned,
                "archived": self.archived, "failed": self.failed, "errors": self.errors[:50]}

    def merge(self, other: "IngestResult") -> None:
        for k in ("added", "existing", "tombstoned", "archived", "failed"):
            setattr(self, k, getattr(self, k) + getattr(other, k))
        self.errors.extend(other.errors)
        self.added_ids.extend(other.added_ids)


class Ingestor:
    def __init__(self, store: EmailStore, archive_dir: Path):
        self.store = store
        self.archive_dir = Path(archive_dir)

    def batch(self) -> "Batch":
        return Batch(self)

    # ── archive ─────────────────────────────────────────────────────────────

    def archive(self, raw: bytes, from_addr: str, file_name: str, source: Path | None = None) -> str:
        """Write the raw message; returns its path relative to archive_dir.
        An identical file already there is reused rather than duplicated, and
        a ``source`` file on the same volume is hard-linked rather than copied
        (ingesting a 60 GB folder of .eml files mustn't need 60 GB more)."""
        folder = self.archive_dir / _domain_dir(from_addr)
        folder.mkdir(parents=True, exist_ok=True)
        name = _safe_name(file_name)
        digest = hashlib.sha256(raw).digest()
        stem, n = name[:-4], 1
        while True:
            path = folder / name
            if not path.exists():
                if source is not None:
                    try:
                        os.link(source, path)
                        break
                    except OSError:
                        pass  # another volume, or no hard links: copy
                tmp = path.with_suffix(".eml.partial")
                tmp.write_bytes(raw)
                tmp.replace(path)
                break
            if path.stat().st_size == len(raw) and hashlib.sha256(path.read_bytes()).digest() == digest:
                break
            name = f"{stem}_{n}.eml"
            n += 1
        return f"{folder.name}/{name}"

    def archived_path(self, rel: str | None) -> Path | None:
        if not rel:
            return None
        path = (self.archive_dir / rel).resolve()
        if self.archive_dir.resolve() not in path.parents or not path.is_file():
            return None
        return path


class Batch:
    """A run of messages written in shared transactions; ``close()`` commits
    the tail and recomputes derived state. Use as a context manager."""

    def __init__(self, ing: Ingestor):
        self.ing = ing
        self.store = ing.store
        get = lambda k: self.store.get_doc("settings", k)  # noqa: E731
        self.clean_rules = CleanRules.from_settings(get)
        self.detect_rules = DetectRules.from_settings(get)
        self.result = IngestResult()
        self._pending = 0
        self._con = None

    def __enter__(self) -> "Batch":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _begin(self):
        if self._con is None:
            self.store.lock.acquire()
            self._con = self.store.con
            self._con.execute("BEGIN IMMEDIATE")
        return self._con

    def _commit(self) -> None:
        if self._con is not None:
            self._con.execute("COMMIT")
            self._con = None
            self._pending = 0
            self.store.lock.release()

    def known(self, eid: str) -> str | None:
        """'tombstoned' / 'archived' (present with its raw file) / 'present' / None."""
        con = self._con or self.store._r()
        if con.execute("SELECT 1 FROM seen_ids WHERE id = ?", (eid,)).fetchone():
            return "tombstoned"
        r = con.execute("SELECT eml_archive_path FROM emails WHERE id = ?", (eid,)).fetchone()
        if not r:
            return None
        return "archived" if self.ing.archived_path(r["eml_archive_path"]) else "present"

    def add(self, raw: bytes, file_name: str, source: Path | None = None) -> str:
        """Ingest one message; returns 'added' / 'existing' / 'archived' /
        'tombstoned' / 'failed'."""
        con = self._begin()
        con.execute("SAVEPOINT msg")
        try:
            status = self._add(raw, file_name, source)
        except Exception as e:  # noqa: BLE001 — one bad message must not stop a batch
            con.execute("ROLLBACK TO msg")
            con.execute("RELEASE msg")
            self.result.failed += 1
            self.result.errors.append(f"{file_name}: {type(e).__name__}: {e}")
            return "failed"
        con.execute("RELEASE msg")
        self._tick()
        return status

    def _add(self, raw: bytes, file_name: str, source: Path | None) -> str:
        con = self._con
        res = self.result
        # Header peek first: a known message is settled without a full parse,
        # which is most of a re-import's cost.
        mid, from_addr = peek_headers(raw)
        if mid:
            state = self.known(mid)
            if state == "tombstoned":
                res.tombstoned += 1
                return "tombstoned"
            if state == "archived":
                res.existing += 1
                return "existing"
            if state == "present":
                rel = self.ing.archive(raw, from_addr, file_name, source)
                con.execute("UPDATE emails SET eml_archive_path = ? WHERE id = ?", (rel, mid))
                res.archived += 1
                return "archived"
        parsed = parse_message(raw)
        eid = email_id(parsed, raw)
        state = self.known(eid)
        if state == "tombstoned":
            res.tombstoned += 1
            return "tombstoned"
        if state == "archived":
            res.existing += 1
            return "existing"
        if state == "present":
            rel = self.ing.archive(raw, parsed.from_addr, file_name, source)
            con.execute("UPDATE emails SET eml_archive_path = ? WHERE id = ?", (rel, eid))
            res.archived += 1
            return "archived"

        body = clean_body(parsed.raw_text_body, self.clean_rules)
        rel = self.ing.archive(raw, parsed.from_addr, file_name, source)
        now = _now()
        record = {
            "id": eid, "messageId": parsed.message_id, "inReplyTo": parsed.in_reply_to,
            "references": parsed.references, "subject": parsed.subject,
            "fromAddr": parsed.from_addr, "fromName": parsed.from_name,
            "toAddrs": parsed.to, "ccAddrs": parsed.cc, "date": parsed.date,
            "isSystemEmail": is_system_email(parsed.headers, parsed.from_addr, parsed.subject, body,
                                             self.detect_rules),
            "status": "unread", "tags": [], "hasAttachments": bool(parsed.attachments),
            "attachmentCount": len(parsed.attachments), "importedAt": now,
            "fileName": file_name, "emlArchivePath": rel,
        }
        if not self.store.add_missing_emails(con, [record]):
            res.existing += 1
            return "existing"
        if body:
            con.execute("INSERT OR REPLACE INTO bodies(id, text) VALUES (?, ?)", (eid, body))
        if parsed.message_id:
            con.execute("INSERT OR REPLACE INTO msg_index(message_id, email_id) VALUES (?, ?)",
                        (parsed.message_id, eid))
        self.add_attachments(con, eid, parsed.attachments, now)
        self.store._fts_sync(con, [eid])
        # Threads and needs_my_reply are stale until close() rederives; if the
        # process dies first, the next start sees this and finishes the job.
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('derive_pending', '1')")
        res.added += 1
        res.added_ids.append(eid)
        return "added"

    def add_attachments(self, con, eid: str, atts: list[ParsedAttachment], now: str) -> int:
        """Insert attachment records not already present; returns how many."""
        added = 0
        used: set[str] = set()

        def unique(base: str) -> str:
            aid, n = base, 2
            while aid in used:
                aid, n = f"{base}::{n}", n + 1
            used.add(aid)
            return aid

        def put(aid: str, a: ParsedAttachment, nested: bool, parent: str | None) -> None:
            nonlocal added
            blacklisted = con.execute("SELECT 1 FROM attachments WHERE hash = ? AND is_blacklisted = 1",
                                      (a.hash,)).fetchone() is not None
            cur = con.execute(
                "INSERT OR IGNORE INTO attachments(id, email_id, filename, content_type, size, hash, "
                "content_id, is_nested, parent_filename, is_blacklisted, imported_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (aid, eid, a.filename, a.content_type, a.size, a.hash, a.content_id,
                 1 if nested else 0, parent, 1 if blacklisted else None, now))
            added += cur.rowcount

        for a in atts:
            aid = unique(f"{eid}::{a.filename}")
            put(aid, a, False, None)
            for n in a.nested:
                put(unique(f"{aid}::{n.filename}"), n, True, a.filename)
        return added

    def _tick(self) -> None:
        self._pending += 1
        if self._pending >= BATCH_COMMIT:
            self._commit()

    def close(self) -> IngestResult:
        self._commit()
        self.store.rederive_if_pending()
        return self.result


def iter_eml_paths(paths: list[Path]):
    """Every .eml file under the given files/folders, in a stable order."""
    for p in paths:
        p = Path(p).expanduser()
        if p.is_dir():
            yield from sorted(x for x in p.rglob("*") if x.is_file() and x.suffix.lower() == ".eml")
        elif p.is_file():
            yield p


def ingest_paths(ing: Ingestor, paths: list[Path], progress=None) -> IngestResult:
    files = list(iter_eml_paths(paths))
    with ing.batch() as b:
        for i, f in enumerate(files, 1):
            b.add(f.read_bytes(), f.name, source=f)
            if progress and (i % 500 == 0 or i == len(files)):
                progress(i, len(files), b.result)
    return b.result


def reparse(ing: Ingestor, email_id_: str) -> dict:
    """Re-read an email's archived original: returns its uncleaned body (for
    the detail panel's truncation controls) and records any attachments the
    first import missed — v1's reimportEmlBody, served from the archive."""
    store = ing.store
    rec = store.get_email(email_id_)
    path = ing.archived_path(rec.get("emlArchivePath"))
    if path is None:
        raise FileNotFoundError("no archived original for this email")
    parsed = parse_message(path.read_bytes())
    b = ing.batch()
    con = b._begin()
    try:
        added = b.add_attachments(con, email_id_, parsed.attachments, _now())
        if added:
            n = con.execute("SELECT COUNT(*) FROM attachments WHERE email_id = ? AND is_nested = 0",
                            (email_id_,)).fetchone()[0]
            con.execute("UPDATE emails SET has_attachments = ?, attachment_count = ? WHERE id = ?",
                        (1 if n else 0, n, email_id_))
    finally:
        b._commit()
    return {"rawTextBody": parsed.raw_text_body, "attachmentsAdded": added,
            "email": store.get_email(email_id_)}
