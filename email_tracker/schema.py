"""The email.db schema and the mapping between v1's camelCase records and rows.

v1 stored each record as a JS object in an IndexedDB store; the API still
speaks that shape, so the UI works unchanged. Here the fields that anything
queries become real columns, arrays become JSON text (life-mcp already filters
``tags`` with LIKE), and every key the schema doesn't know goes into an
``extra`` JSON column so a backup round-trips without loss.

``null`` and "absent" are not distinguished: both are stored as NULL and
dropped from the record on the way out, which the UI already treats alike.
"""
from __future__ import annotations

import json
from typing import Any

SCHEMA_VERSION = 2

DDL = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- seq is an INTEGER PRIMARY KEY so the rowid is stable across VACUUM, which
-- emails_fts depends on (it is keyed by rowid, as life-mcp's search expects).
CREATE TABLE IF NOT EXISTS emails (
  seq                    INTEGER PRIMARY KEY,
  id                     TEXT NOT NULL UNIQUE,
  message_id             TEXT,
  in_reply_to            TEXT,
  references_json        TEXT,
  thread_id              TEXT,
  subject                TEXT,
  from_addr              TEXT,
  from_name              TEXT,
  to_addrs               TEXT,
  cc_addrs               TEXT,
  date                   TEXT,
  status                 TEXT,
  is_system_email        INTEGER,
  manual_system_override INTEGER,
  has_attachments        INTEGER,
  attachment_count       INTEGER,
  tags                   TEXT,
  tag_exclusions         TEXT,
  imported_at            TEXT,
  file_name              TEXT,
  eml_archive_path       TEXT,
  extra                  TEXT,
  needs_my_reply         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id  ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_date       ON emails(date);
CREATE INDEX IF NOT EXISTS idx_emails_from_addr  ON emails(from_addr);
CREATE INDEX IF NOT EXISTS idx_emails_status     ON emails(status);

-- Bodies stay out of the emails table, as they stayed out of v1's emails
-- store: listing the corpus never has to read them. No row = empty body.
CREATE TABLE IF NOT EXISTS bodies (
  id   TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id                TEXT PRIMARY KEY,
  email_id          TEXT REFERENCES emails(id) ON DELETE CASCADE,
  filename          TEXT,
  content_type      TEXT,
  size              INTEGER,
  hash              TEXT,
  content_id        TEXT,
  is_nested         INTEGER,
  parent_filename   TEXT,
  is_blacklisted    INTEGER,
  extracted_text    TEXT,
  extraction_status TEXT,
  extraction_note   TEXT,
  extracted_at      INTEGER,
  imported_at       TEXT,
  extra             TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_hash  ON attachments(hash);

CREATE TABLE IF NOT EXISTS msg_index (
  message_id TEXT PRIMARY KEY,
  email_id   TEXT NOT NULL
);

-- Tombstones: a discarded id is never re-imported.
CREATE TABLE IF NOT EXISTS seen_ids (id TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS tags (
  name  TEXT PRIMARY KEY,
  extra TEXT
);

-- Records whose whole shape is owned by the UI are kept as JSON documents.
CREATE TABLE IF NOT EXISTS smart_views  (id  TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_groups (id  TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings     (key TEXT PRIMARY KEY, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS address_book (
  email    TEXT PRIMARY KEY,
  name     TEXT,
  role     TEXT,
  projects TEXT,
  notes    TEXT,
  extra    TEXT
);

-- Full-text index over subject, sender and body, keyed by emails.seq. Kept in
-- step by EmailStore (a trigger can't: the body lives in another table).
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, from_name, from_addr, body
);
"""

# ── Record ⇄ row mapping ─────────────────────────────────────────────────────
# (record key, column, kind). kind: "text" stored as-is, "json" as JSON text,
# "bool" as 0/1.

EMAIL_FIELDS: list[tuple[str, str, str]] = [
    ("id", "id", "text"),
    ("messageId", "message_id", "text"),
    ("inReplyTo", "in_reply_to", "text"),
    ("references", "references_json", "json"),
    ("subject", "subject", "text"),
    ("fromAddr", "from_addr", "text"),
    ("fromName", "from_name", "text"),
    ("toAddrs", "to_addrs", "json"),
    ("ccAddrs", "cc_addrs", "json"),
    ("date", "date", "text"),
    ("status", "status", "text"),
    ("isSystemEmail", "is_system_email", "bool"),
    ("manualSystemOverride", "manual_system_override", "bool"),
    ("hasAttachments", "has_attachments", "bool"),
    ("attachmentCount", "attachment_count", "text"),
    ("tags", "tags", "json"),
    ("tagExclusions", "tag_exclusions", "json"),
    ("importedAt", "imported_at", "text"),
    ("fileName", "file_name", "text"),
    ("emlArchivePath", "eml_archive_path", "text"),
]
# Derived server-side; an incoming value is ignored, the outgoing one is real.
EMAIL_DERIVED: list[tuple[str, str, str]] = [
    ("threadId", "thread_id", "text"),
    ("needsMyReply", "needs_my_reply", "bool"),
]
# Never persisted: v1 bodies travel inline in backups only; _lc is the UI's cache slot.
EMAIL_DROPPED = {"textBody", "_lc"}

ATTACHMENT_FIELDS: list[tuple[str, str, str]] = [
    ("id", "id", "text"),
    ("emailId", "email_id", "text"),
    ("filename", "filename", "text"),
    ("contentType", "content_type", "text"),
    ("size", "size", "text"),
    ("hash", "hash", "text"),
    ("contentId", "content_id", "text"),
    ("isNested", "is_nested", "bool"),
    ("parentFilename", "parent_filename", "text"),
    ("isBlacklisted", "is_blacklisted", "bool"),
    ("extractedText", "extracted_text", "text"),
    ("extractionStatus", "extraction_status", "text"),
    ("extractionNote", "extraction_note", "text"),
    ("extractedAt", "extracted_at", "text"),
    ("importedAt", "imported_at", "text"),
]
# The attachment list the UI loads for every email skips the extracted text.
ATTACHMENT_HEAVY = {"extractedText"}

ADDRESS_FIELDS: list[tuple[str, str, str]] = [
    ("email", "email", "text"),
    ("name", "name", "text"),
    ("role", "role", "text"),
    ("projects", "projects", "json"),
    ("notes", "notes", "text"),
]

TAG_FIELDS: list[tuple[str, str, str]] = [("name", "name", "text")]


def _encode(kind: str, value: Any) -> Any:
    if value is None:
        return None
    if kind == "json":
        return json.dumps(value, ensure_ascii=False)
    if kind == "bool":
        return 1 if value else 0
    return value


def _decode(kind: str, value: Any) -> Any:
    if value is None:
        return None
    if kind == "json":
        return json.loads(value)
    if kind == "bool":
        return bool(value)
    return value


def to_row(record: dict, fields: list[tuple[str, str, str]],
           skip: set[str] = frozenset()) -> dict[str, Any]:
    """Map a v1 record to column values; unknown keys go into ``extra``."""
    known = {k for k, _, _ in fields}
    row = {col: _encode(kind, record.get(key)) for key, col, kind in fields}
    extra = {k: v for k, v in record.items()
             if k not in known and k not in skip and v is not None}
    row["extra"] = json.dumps(extra, ensure_ascii=False) if extra else None
    return row


def from_row(row: Any, fields: list[tuple[str, str, str]],
             derived: list[tuple[str, str, str]] | None = None,
             omit: set[str] = frozenset()) -> dict:
    """Map a row (sqlite3.Row) back to the v1 record shape."""
    rec: dict[str, Any] = {}
    keys = row.keys()
    for key, col, kind in fields:
        if key in omit or col not in keys:
            continue
        v = _decode(kind, row[col])
        if v is not None:
            rec[key] = v
    for key, col, kind in derived or []:
        if col in keys and row[col] is not None:
            rec[key] = _decode(kind, row[col])
    if "extra" in keys and row["extra"]:
        for k, v in json.loads(row["extra"]).items():
            rec.setdefault(k, v)
    return rec


def columns(fields: list[tuple[str, str, str]]) -> list[str]:
    return [col for _, col, _ in fields] + ["extra"]
