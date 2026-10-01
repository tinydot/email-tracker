"""The schemaVersion-3 backup JSON, read and written as a stream.

This is the bridge from v1: the browser app's "Export JSON" (and Google Drive
backups) are this format, and ``GET /api/export`` writes it back out, so a v2
database can still be loaded into the v1 app.

Reading is a port of ``makeBackupScanner`` / ``applyBackupStream`` in
js/export.js. The document is a flat object of record arrays, so the scanner
only finds record *boundaries* — tracking string and escape state so a brace in
a subject line doesn't count — and hands each record's text to ``json.loads``.
Neither side ever holds the whole file.

Restore semantics are v1's: skip-if-existing throughout, so it never clobbers
current state and re-running a file is a no-op; settings before emails; an
email's inlined ``textBody`` is split back out (blank-line runs collapsed as
v1 did) and a msg_index entry written, but only for emails actually added.
"""
from __future__ import annotations

import io
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import IO, Any

from .store import EmailStore, collapse_blank_lines

STORE_KEYS = {
    "emails": "id", "attachments": "id", "tags": "name", "msgIndex": "messageId",
    "smartViews": "id", "settings": "key", "emailGroups": "id", "seenIds": "id",
    "addressBook": "email",
}
# Flush order: settings first so a restored config is in place; emails before
# msgIndex so an email's own index entry wins over a stale one in the file.
FLUSH_ORDER = ["settings", "emails", "attachments", "tags", "msgIndex", "smartViews",
               "emailGroups", "seenIds", "addressBook"]
EXPORT_ORDER = ["attachments", "tags", "msgIndex", "smartViews", "settings",
                "emailGroups", "seenIds", "addressBook"]

(_AWAIT_ROOT, _KEY, _IN_KEY, _COLON, _VALUE, _ELEMENT, _CAPTURE, _DONE) = range(8)
_SPACE = " \n\r\t"


class BackupFormatError(ValueError):
    pass


class BackupScanner:
    """Feed text chunks in order, then ``end()``. ``on_value(key, value)`` fires
    once per element of each top-level array and once per top-level scalar."""

    def __init__(self, on_value: Callable[[str, Any], None]):
        self.on_value = on_value
        self.phase = _AWAIT_ROOT
        self.key_raw: list[str] = []
        self.key_esc = False
        self.cur_key: str | None = None
        self.buf: list[str] = []
        self.kind = ""
        self.depth = 0
        self.in_str = False
        self.esc = False
        self.from_array = False

    def _start(self, ch: str, in_array: bool) -> None:
        self.buf = [ch]
        self.depth = 0
        self.in_str = False
        self.esc = False
        self.from_array = in_array
        if ch in "{[":
            self.kind, self.depth = "struct", 1
        elif ch == '"':
            self.kind, self.in_str = "string", True
        else:
            self.kind = "scalar"
        self.phase = _CAPTURE

    def _emit(self) -> None:
        text = "".join(self.buf)
        self.buf = []
        try:
            value = json.loads(text)
        except ValueError as e:
            raise BackupFormatError(f"Malformed record under {self.cur_key!r}: {e}") from None
        self.on_value(self.cur_key, value)
        self.phase = _ELEMENT if self.from_array else _KEY

    def feed(self, chunk: str) -> None:
        i, n = 0, len(chunk)
        while i < n:
            ch = chunk[i]
            ph = self.phase
            if ph == _CAPTURE:
                # Fast path: copy a run of ordinary characters in one slice.
                if self.in_str:
                    j = i
                    while j < n and chunk[j] not in '"\\' and not self.esc:
                        j += 1
                    if j > i:
                        self.buf.append(chunk[i:j])
                        i = j
                        continue
                if self.kind == "scalar" and not self.in_str and (ch in _SPACE or ch in ",}]"):
                    self._emit()
                    continue  # re-read the delimiter in the next phase
                self.buf.append(ch)
                if self.in_str:
                    if self.esc:
                        self.esc = False
                    elif ch == "\\":
                        self.esc = True
                    elif ch == '"':
                        self.in_str = False
                        if self.kind == "string" and self.depth == 0:
                            self._emit()
                elif ch == '"':
                    self.in_str = True
                elif ch in "{[":
                    self.depth += 1
                elif ch in "}]":
                    self.depth -= 1
                    if self.depth == 0:
                        self._emit()
            elif ph == _AWAIT_ROOT:
                if ch not in _SPACE:
                    if ch != "{":
                        raise BackupFormatError("Not a backup file")
                    self.phase = _KEY
            elif ph == _KEY:
                if ch in _SPACE or ch == ",":
                    pass
                elif ch == "}":
                    self.phase = _DONE
                elif ch == '"':
                    self.key_raw, self.key_esc = [], False
                    self.phase = _IN_KEY
                else:
                    raise BackupFormatError(f'Malformed backup near "{ch}"')
            elif ph == _IN_KEY:
                if self.key_esc:
                    self.key_raw.append(ch)
                    self.key_esc = False
                elif ch == "\\":
                    self.key_raw.append(ch)
                    self.key_esc = True
                elif ch == '"':
                    self.cur_key = json.loads('"' + "".join(self.key_raw) + '"')
                    self.phase = _COLON
                else:
                    self.key_raw.append(ch)
            elif ph == _COLON:
                if ch not in _SPACE:
                    if ch != ":":
                        raise BackupFormatError('Malformed backup: expected ":"')
                    self.phase = _VALUE
            elif ph == _VALUE:
                if ch not in _SPACE:
                    if ch == "[":
                        self.phase = _ELEMENT
                    else:
                        self._start(ch, False)
            elif ph == _ELEMENT:
                if ch in _SPACE or ch == ",":
                    pass
                elif ch == "]":
                    self.phase = _KEY
                else:
                    self._start(ch, True)
            elif ph == _DONE:
                if ch not in _SPACE:
                    raise BackupFormatError("Trailing data after backup")
            i += 1

    def end(self) -> None:
        if self.phase != _DONE:
            raise BackupFormatError("Backup file ended unexpectedly")


@dataclass
class RestoreResult:
    added: dict[str, int] = field(default_factory=lambda: {k: 0 for k in STORE_KEYS})
    emails_skipped: int = 0
    total_records: int = 0
    stores_seen: set[str] = field(default_factory=set)
    error: str | None = None

    def as_dict(self) -> dict:
        return {"added": self.added, "emailsSkipped": self.emails_skipped,
                "totalRecords": self.total_records, "storesSeen": sorted(self.stores_seen),
                "error": self.error}


def apply_backup(store: EmailStore, chunks: Iterable[str], batch_size: int = 2000) -> RestoreResult:
    """Merge a backup into ``store``. ``chunks`` yields decoded text.

    Records are buffered only up to ``batch_size`` and written one transaction
    per batch. A file that turns out malformed partway leaves the earlier
    records restored; the result's ``error`` says so, and re-running a fixed
    file skips them.
    """
    res = RestoreResult()
    pending: dict[str, list] = {k: [] for k in STORE_KEYS}
    buffered = 0

    def flush() -> None:
        nonlocal buffered
        if not buffered:
            return
        with store.tx() as con:
            for name in FLUSH_ORDER:
                batch, pending[name] = pending[name], []
                if not batch:
                    continue
                if name == "emails":
                    extras: dict[str, tuple[str, str | None]] = {}
                    metas = []
                    for email in batch:
                        if not isinstance(email, dict) or not email.get("id"):
                            continue
                        body = email.pop("textBody", None)
                        body = collapse_blank_lines(body) if isinstance(body, str) and body else ""
                        extras[email["id"]] = (body, email.get("messageId"))
                        metas.append(email)
                    added = store.add_missing_emails(con, metas)
                    res.emails_skipped += len(metas) - len(added)
                    res.added["emails"] += len(added)
                    for eid in added:
                        body, msg_id = extras[eid]
                        if body:
                            con.execute("INSERT OR REPLACE INTO bodies(id, text) VALUES (?, ?)", (eid, body))
                        if msg_id:  # overwrites, as v1 did
                            con.execute("INSERT OR REPLACE INTO msg_index(message_id, email_id) VALUES (?, ?)",
                                        (msg_id, eid))
                    store._fts_sync(con, added)
                else:
                    recs = [r for r in batch if isinstance(r, dict)]
                    res.added[name] += store.add_missing_rows(con, name, recs)
        buffered = 0

    def on_value(key: str, value: Any) -> None:
        nonlocal buffered
        if key not in pending:
            return  # schemaVersion, exportedAt, unknown keys
        pending[key].append(value)
        res.stores_seen.add(key)
        res.total_records += 1
        buffered += 1

    scanner = BackupScanner(on_value)
    try:
        for chunk in chunks:
            scanner.feed(chunk)
            if buffered >= batch_size:
                flush()
        scanner.end()
    except BackupFormatError as e:
        flush()  # keep whatever was already parsed
        done = sum(res.added.values())
        res.error = str(e) + (f" — {done} record{'s' if done != 1 else ''} were restored before the error"
                              if done else "")
    else:
        flush()
    if res.added["emails"]:
        store.rederive()
    return res


def read_text_chunks(fh: IO[bytes], size: int = 1 << 20) -> Iterable[str]:
    """Decode a byte stream as UTF-8 in chunks (multi-byte safe)."""
    reader = io.TextIOWrapper(fh, encoding="utf-8", newline="")
    while True:
        chunk = reader.read(size)
        if not chunk:
            return
        yield chunk


def stream_backup_json(store: EmailStore, write: Callable[[str], Any]) -> int:
    """Write the whole database as a schemaVersion-3 backup; returns emails written."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    write('{"schemaVersion":3,"exportedAt":' + json.dumps(now))
    dumps = lambda r: json.dumps(r, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    write(',"emails":[')
    n = 0
    for rec in store.iter_emails_with_bodies():
        write(("," if n else "") + dumps(rec))
        n += 1
    write("]")
    for key in EXPORT_ORDER:
        write(',"' + key + '":[')
        first = True
        for rec in store.iter_store(key):
            write(("" if first else ",") + dumps(rec))
            first = False
        write("]")
    write("}")
    return n
