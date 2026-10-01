"""EmailStore: the one writer of email.db.

Every write — the API's, the backup importer's, later the .eml ingest's — goes
through this class, on one connection, under one lock. Other processes
(life-mcp) open the file read-only.

Derived state is kept in step here, not by callers: ``thread_id`` is recomputed
after anything that adds or removes emails, and ``emails_fts`` is refreshed for
every email whose subject, sender or body changes.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import schema
from .schema import (ADDRESS_FIELDS, ATTACHMENT_FIELDS, ATTACHMENT_HEAVY, EMAIL_DERIVED,
                     EMAIL_DROPPED, EMAIL_FIELDS, TAG_FIELDS, from_row, to_row)
from .parse import normalize_address
from .threading_ids import compute_thread_ids

# Fields the UI may change on an email. Everything else is set at ingest.
EMAIL_PATCHABLE = {"status", "tags", "tagExclusions", "isSystemEmail", "manualSystemOverride"}

# Document stores: table, key column.
DOC_TABLES = {"smartViews": ("smart_views", "id"),
              "emailGroups": ("email_groups", "id"),
              "settings": ("settings", "key")}

_BLANK_RUNS = re.compile(r"(\n[ \t]*){2,}")      # applyBackupStream's collapse
_BLANK_LINES = re.compile(r"\n([ \t]*\n)+")      # normalizeLineBreaks'
_HIGH_BYTE = re.compile(r"[\x80-\xff]")
# Subjects that never ask for a reply (needs_my_reply).
_NOT_A_REQUEST = re.compile(r"^\s*(accepted|declined|tentative|canceled|cancelled|"
                            r"automatic reply|auto-?reply|out of office)\b", re.I)
DIRECT_MAX_TO = 3


class NotFound(KeyError):
    pass


def collapse_blank_lines(text: str) -> str:
    return _BLANK_RUNS.sub("\n", text)


def repair_mojibake(orig: Any) -> str | None:
    """The repaired string, or None if ``orig`` isn't UTF-8 mis-decoded as
    Latin-1. Mirrors ``fixMojibakeEmails`` in js/smart-views/settings.js,
    including its byte truncation of code points above 0xFF (which makes a
    string with real non-Latin-1 text fail the strict decode and stay as is)."""
    if not isinstance(orig, str) or not _HIGH_BYTE.search(orig):
        return None
    try:
        repaired = bytes(ord(c) & 0xFF for c in orig).decode("utf-8")
    except UnicodeDecodeError:
        return None
    return repaired if repaired != orig else None


def _unicode_lower(s: Any) -> Any:
    # SQLite's lower() folds ASCII only; the UI's search uses toLowerCase().
    return s.lower() if isinstance(s, str) else s


def normalize_addresses(rec: dict) -> dict:
    """Bare, lowercase, de-duplicated addresses (v1 sometimes kept '<x@y>')."""
    out = dict(rec)
    if isinstance(out.get("fromAddr"), str):
        out["fromAddr"] = normalize_address(out["fromAddr"])
    for k in ("toAddrs", "ccAddrs"):
        if isinstance(out.get(k), list):
            seen: list[str] = []
            for a in out[k]:
                a = normalize_address(a) if isinstance(a, str) else ""
                if a and a not in seen:
                    seen.append(a)
            out[k] = seen
    return out


class EmailStore:
    def __init__(self, path: Path | str, my_addresses: Iterable[str] = ()):
        self.path = Path(path)
        # The owner's addresses: needs_my_reply keys on them (config my_addresses).
        self.my_addresses = {normalize_address(a) for a in my_addresses if a}
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.con = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA journal_mode = WAL")
        self.con.execute("PRAGMA foreign_keys = ON")
        self.con.execute("PRAGMA synchronous = NORMAL")
        self.con.create_function("ulower", 1, _unicode_lower, deterministic=True)
        with self.lock:
            self.con.executescript(schema.DDL)
            cur = self.meta("schema_version")
            if cur is None:
                self.set_meta("schema_version", str(schema.SCHEMA_VERSION))
            elif int(cur) > schema.SCHEMA_VERSION:
                raise RuntimeError(f"{self.path} has schema v{cur}; this code knows v{schema.SCHEMA_VERSION}")
            elif int(cur) < 2:
                self._migrate_v2()

        self._local = threading.local()
        self._readers: list[sqlite3.Connection] = []

    def _r(self) -> sqlite3.Connection:
        """This thread's read connection. Reads never share the writer's
        connection, so a long read (an export) can't see a half-done write, and
        WAL lets them run alongside it."""
        con = getattr(self._local, "con", None)
        if con is None:
            con = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA query_only = 1")
            con.create_function("ulower", 1, _unicode_lower, deterministic=True)
            self._local.con = con
            with self.lock:
                self._readers.append(con)
        return con

    def _migrate_v2(self) -> None:
        """v2 (Phase 2): the needs_my_reply column, and addresses normalised to
        the bare lowercase form the Python parser produces."""
        with self.tx() as con:
            cols = {r["name"] for r in con.execute("PRAGMA table_info(emails)")}
            if "needs_my_reply" not in cols:
                con.execute("ALTER TABLE emails ADD COLUMN needs_my_reply INTEGER")
            for r in con.execute("SELECT id, from_addr, to_addrs, cc_addrs FROM emails").fetchall():
                rec = {"fromAddr": r["from_addr"],
                       "toAddrs": json.loads(r["to_addrs"]) if r["to_addrs"] else None,
                       "ccAddrs": json.loads(r["cc_addrs"]) if r["cc_addrs"] else None}
                new = normalize_addresses(rec)
                if new != rec:
                    con.execute("UPDATE emails SET from_addr = ?, to_addrs = ?, cc_addrs = ? WHERE id = ?",
                                (new["fromAddr"],
                                 None if new["toAddrs"] is None else json.dumps(new["toAddrs"], ensure_ascii=False),
                                 None if new["ccAddrs"] is None else json.dumps(new["ccAddrs"], ensure_ascii=False),
                                 r["id"]))
            self.set_meta("schema_version", "2")
            self.set_meta("derive_pending", "1")

    def close(self) -> None:
        for con in self._readers:
            con.close()
        self.con.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.lock:
            self.con.execute("BEGIN IMMEDIATE")
            try:
                yield self.con
            except BaseException:
                self.con.execute("ROLLBACK")
                raise
            self.con.execute("COMMIT")

    # ── meta ────────────────────────────────────────────────────────────────

    def meta(self, key: str) -> str | None:
        r = self.con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        self.con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))

    # ── emails ──────────────────────────────────────────────────────────────

    @staticmethod
    def _email(row: sqlite3.Row) -> dict:
        return from_row(row, EMAIL_FIELDS, EMAIL_DERIVED)

    def list_emails(self) -> list[dict]:
        rows = self._r().execute("SELECT * FROM emails ORDER BY seq").fetchall()
        return [self._email(r) for r in rows]

    def get_email(self, email_id: str) -> dict:
        r = self._r().execute("SELECT * FROM emails WHERE id = ?", (email_id,)).fetchone()
        if not r:
            raise NotFound(email_id)
        return self._email(r)

    def patch_email(self, email_id: str, fields: dict) -> dict:
        """Apply the UI-editable fields in ``fields``; anything else is ignored."""
        changes = {k: v for k, v in fields.items() if k in EMAIL_PATCHABLE}
        with self.tx() as con:
            r = con.execute("SELECT * FROM emails WHERE id = ?", (email_id,)).fetchone()
            if not r:
                raise NotFound(email_id)
            if changes:
                cols = {col: kind for key, col, kind in EMAIL_FIELDS if key in changes}
                row = to_row(changes, [f for f in EMAIL_FIELDS if f[0] in changes])
                sets = ", ".join(f"{c} = ?" for c in cols)
                con.execute(f"UPDATE emails SET {sets} WHERE id = ?",
                            [row[c] for c in cols] + [email_id])
                if "isSystemEmail" in changes:  # automated mail never needs a reply
                    self._needs_reply(con)
        return self.get_email(email_id)

    def _delete_emails(self, con: sqlite3.Connection, ids: list[str], tombstone: bool) -> None:
        for eid in ids:
            r = con.execute("SELECT seq FROM emails WHERE id = ?", (eid,)).fetchone()
            if not r:
                continue
            con.execute("DELETE FROM emails_fts WHERE rowid = ?", (r["seq"],))
            con.execute("DELETE FROM msg_index WHERE email_id = ?", (eid,))
            # bodies and attachments cascade
            con.execute("DELETE FROM emails WHERE id = ?", (eid,))
            if tombstone:
                con.execute("INSERT OR IGNORE INTO seen_ids(id) VALUES (?)", (eid,))

    def delete_email(self, email_id: str) -> None:
        # Like v1's single delete: no tombstone, so a re-import brings it back.
        with self.tx() as con:
            if not con.execute("SELECT 1 FROM emails WHERE id = ?", (email_id,)).fetchone():
                raise NotFound(email_id)
            self._delete_emails(con, [email_id], tombstone=False)
            self._rederive(con)

    def discard_automated(self) -> list[str]:
        """Delete every automated email the user hasn't unflagged, remembering
        each id so it is never re-imported. Returns the ids discarded."""
        with self.tx() as con:
            ids = [r["id"] for r in con.execute(
                "SELECT id FROM emails WHERE is_system_email = 1 "
                "AND COALESCE(manual_system_override, 0) = 0")]
            self._delete_emails(con, ids, tombstone=True)
            self._rederive(con)
        return ids

    def is_tombstoned(self, email_id: str) -> bool:
        return self._r().execute("SELECT 1 FROM seen_ids WHERE id = ?", (email_id,)).fetchone() is not None

    # ── bodies ──────────────────────────────────────────────────────────────

    def get_body(self, email_id: str) -> str:
        r = self._r().execute("SELECT text FROM bodies WHERE id = ?", (email_id,)).fetchone()
        return r["text"] if r else ""

    def put_body(self, email_id: str, text: str) -> None:
        """Replace a body; an empty one removes the row, as v1's putBody did."""
        with self.tx() as con:
            if not con.execute("SELECT 1 FROM emails WHERE id = ?", (email_id,)).fetchone():
                raise NotFound(email_id)
            if text:
                con.execute("INSERT OR REPLACE INTO bodies(id, text) VALUES (?, ?)", (email_id, text))
            else:
                con.execute("DELETE FROM bodies WHERE id = ?", (email_id,))
            self._fts_sync(con, [email_id])

    def bodies_for(self, ids: Iterable[str]) -> Iterator[tuple[str, str]]:
        ids = list(ids)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            q = f"SELECT id, text FROM bodies WHERE id IN ({','.join('?' * len(chunk))})"
            for r in self._r().execute(q, chunk):
                yield r["id"], r["text"]

    def search_body_ids(self, term: str) -> list[str]:
        """Ids whose body contains ``term``, case-insensitively — the same
        substring test v1's scanBodiesFor ran (not FTS token matching)."""
        term = term.lower()
        if not term:
            return []
        return [r["id"] for r in self._r().execute(
            "SELECT id FROM bodies WHERE instr(ulower(text), ?) > 0", (term,))]

    # ── attachments ─────────────────────────────────────────────────────────

    def list_attachments(self, email_id: str | None = None, light: bool = False) -> list[dict]:
        omit = ATTACHMENT_HEAVY if light else frozenset()
        cols = "*" if not light else ", ".join(
            c for k, c, _ in ATTACHMENT_FIELDS if k not in omit) + ", extra"
        if email_id is None:
            rows = self._r().execute(f"SELECT {cols} FROM attachments ORDER BY rowid")
        else:
            rows = self._r().execute(f"SELECT {cols} FROM attachments WHERE email_id = ? ORDER BY rowid",
                                    (email_id,))
        return [from_row(r, ATTACHMENT_FIELDS, omit=omit) for r in rows]

    def toggle_attachment_blacklisted(self, att_id: str) -> dict:
        with self.tx() as con:
            cur = con.execute("UPDATE attachments SET is_blacklisted = 1 - COALESCE(is_blacklisted, 0) "
                              "WHERE id = ?", (att_id,))
            if cur.rowcount == 0:
                raise NotFound(att_id)
        r = self._r().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
        return from_row(r, ATTACHMENT_FIELDS)

    # ── document stores: smart views, email groups, settings ────────────────

    def list_docs(self, store: str) -> list[dict]:
        table, _ = DOC_TABLES[store]
        return [json.loads(r["json"]) for r in self._r().execute(f"SELECT json FROM {table} ORDER BY rowid")]

    def get_doc(self, store: str, key: str) -> dict | None:
        table, kcol = DOC_TABLES[store]
        r = self._r().execute(f"SELECT json FROM {table} WHERE {kcol} = ?", (key,)).fetchone()
        return json.loads(r["json"]) if r else None

    def put_doc(self, store: str, record: dict) -> dict:
        table, kcol = DOC_TABLES[store]
        key = record.get(kcol)
        if not isinstance(key, str) or not key:
            raise ValueError(f"{store} record needs a string '{kcol}'")
        if store == "settings" and "handle" in record:
            raise ValueError("folder handles are machine-local and not stored on the server")
        with self.tx() as con:
            con.execute(f"INSERT OR REPLACE INTO {table}({kcol}, json) VALUES (?, ?)",
                        (key, json.dumps(record, ensure_ascii=False)))
        return record

    def delete_doc(self, store: str, key: str) -> None:
        table, kcol = DOC_TABLES[store]
        with self.tx() as con:
            con.execute(f"DELETE FROM {table} WHERE {kcol} = ?", (key,))

    # ── address book ────────────────────────────────────────────────────────

    def list_contacts(self) -> list[dict]:
        return [from_row(r, ADDRESS_FIELDS) for r in self._r().execute("SELECT * FROM address_book ORDER BY rowid")]

    def get_contact(self, email: str) -> dict | None:
        r = self._r().execute("SELECT * FROM address_book WHERE email = ?", (email,)).fetchone()
        return from_row(r, ADDRESS_FIELDS) if r else None

    def put_contact(self, record: dict) -> dict:
        if not isinstance(record.get("email"), str) or not record["email"]:
            raise ValueError("contact needs an 'email'")
        row = to_row(record, ADDRESS_FIELDS)
        cols = schema.columns(ADDRESS_FIELDS)
        with self.tx() as con:
            con.execute(f"INSERT OR REPLACE INTO address_book({','.join(cols)}) "
                        f"VALUES ({','.join('?' * len(cols))})", [row[c] for c in cols])
        return self.get_contact(record["email"])

    def delete_contact(self, email: str) -> None:
        with self.tx() as con:
            con.execute("DELETE FROM address_book WHERE email = ?", (email,))

    # ── maintenance ─────────────────────────────────────────────────────────

    def fix_mojibake(self) -> int:
        """Repair UTF-8 mis-decoded as Latin-1 in subjects, sender names and
        bodies. Returns the number of records changed (headers + bodies, as v1
        counted them)."""
        fixed = 0
        with self.tx() as con:
            touched: set[str] = set()
            for r in con.execute("SELECT id, subject, from_name FROM emails").fetchall():
                subj, name = repair_mojibake(r["subject"]), repair_mojibake(r["from_name"])
                if subj is None and name is None:
                    continue
                con.execute("UPDATE emails SET subject = COALESCE(?, subject), "
                            "from_name = COALESCE(?, from_name) WHERE id = ?", (subj, name, r["id"]))
                touched.add(r["id"])
                fixed += 1
            for r in con.execute("SELECT id, text FROM bodies").fetchall():
                t = repair_mojibake(r["text"])
                if t is not None:
                    con.execute("UPDATE bodies SET text = ? WHERE id = ?", (t, r["id"]))
                    touched.add(r["id"])
                    fixed += 1
            self._fts_sync(con, touched)
        return fixed

    def normalize_linebreaks(self) -> int:
        fixed = 0
        with self.tx() as con:
            touched = []
            for r in con.execute("SELECT id, text FROM bodies").fetchall():
                t = _BLANK_LINES.sub("\n", r["text"].replace("\r\n", "\n"))
                if t != r["text"]:
                    con.execute("UPDATE bodies SET text = ? WHERE id = ?", (t, r["id"]))
                    touched.append(r["id"])
            fixed = len(touched)
            self._fts_sync(con, touched)
        return fixed

    # ── derived state ───────────────────────────────────────────────────────

    def _rethread(self, con: sqlite3.Connection) -> int:
        """Recompute thread_id for the whole corpus and write the changes.

        A full pass (~27k rows) is milliseconds, and a delete or insert can
        re-root any number of emails, so nothing narrower is worth the risk."""
        rows = con.execute("SELECT id, message_id, in_reply_to, references_json, thread_id FROM emails").fetchall()
        current = {r["id"]: r["thread_id"] for r in rows}
        roots = compute_thread_ids({
            "id": r["id"], "messageId": r["message_id"], "inReplyTo": r["in_reply_to"],
            "references": json.loads(r["references_json"]) if r["references_json"] else [],
        } for r in rows)
        changed = [(root, eid) for eid, root in roots.items() if current.get(eid) != root]
        con.executemany("UPDATE emails SET thread_id = ? WHERE id = ?", changed)
        return len(changed)

    def _needs_reply(self, con: sqlite3.Connection) -> int:
        """Flag threads that are waiting on me. The newest message of a thread
        is flagged when all of these hold:

        - it isn't from me, isn't automated, and has me in To (not just Cc);
        - it isn't a calendar response or auto-reply (Accepted:, Canceled:, …);
        - it's a conversation I'm in — I've written in the thread — or a
          direct note: at most ``DIRECT_MAX_TO`` To recipients, from someone
          I've emailed before.

        The last rule is what keeps out broadcast reports and meeting blasts
        that merely list me (on the 2026-09 corpus: 1,385 → 385 threads). Only
        the newest message carries the flag, so the list shows a thread once.
        """
        me = self.my_addresses
        rows = con.execute("SELECT seq, id, thread_id, date, subject, from_addr, to_addrs, cc_addrs, "
                           "is_system_email, needs_my_reply FROM emails").fetchall()
        flagged: set[str] = set()
        if me:
            newest: dict[str, sqlite3.Row] = {}
            i_wrote: set[str] = set()
            correspondents: set[str] = set()
            for r in rows:
                key = r["thread_id"] or r["id"]
                cur = newest.get(key)
                if cur is None or ((r["date"] or ""), r["seq"]) > ((cur["date"] or ""), cur["seq"]):
                    newest[key] = r
                if normalize_address(r["from_addr"] or "") in me:
                    i_wrote.add(key)
                    for col in ("to_addrs", "cc_addrs"):
                        for a in json.loads(r[col]) if r[col] else []:
                            if isinstance(a, str):
                                correspondents.add(normalize_address(a))
            for key, r in newest.items():
                sender = normalize_address(r["from_addr"] or "")
                if r["is_system_email"] or sender in me or _NOT_A_REQUEST.match(r["subject"] or ""):
                    continue
                to = [normalize_address(a) for a in (json.loads(r["to_addrs"]) if r["to_addrs"] else [])
                      if isinstance(a, str)]
                if not me.intersection(to):
                    continue
                if key in i_wrote or (len(to) <= DIRECT_MAX_TO and sender in correspondents):
                    flagged.add(r["id"])
        changed = [(1 if r["id"] in flagged else 0, r["id"]) for r in rows
                   if (r["needs_my_reply"] or 0) != (1 if r["id"] in flagged else 0)]
        con.executemany("UPDATE emails SET needs_my_reply = ? WHERE id = ?", changed)
        return len(flagged)

    def _rederive(self, con: sqlite3.Connection) -> None:
        """Everything derived from the corpus as a whole: threads, then
        needs_my_reply (which reads them)."""
        self._rethread(con)
        self._needs_reply(con)
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('derive_pending', '0')")

    def rederive(self) -> None:
        with self.tx() as con:
            self._rederive(con)

    def rederive_if_pending(self) -> bool:
        if self.meta("derive_pending") == "1":
            self.rederive()
            return True
        return False

    _FTS_SELECT = ("SELECT e.seq, COALESCE(e.subject, ''), COALESCE(e.from_name, ''), "
                   "COALESCE(e.from_addr, ''), COALESCE(b.text, '') "
                   "FROM emails e LEFT JOIN bodies b ON b.id = e.id")

    def _fts_sync(self, con: sqlite3.Connection, ids: Iterable[str]) -> None:
        ids = list(ids)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            con.execute(f"DELETE FROM emails_fts WHERE rowid IN (SELECT seq FROM emails WHERE id IN ({marks}))", chunk)
            con.execute(f"INSERT INTO emails_fts(rowid, subject, from_name, from_addr, body) "
                        f"{self._FTS_SELECT} WHERE e.id IN ({marks})", chunk)

    def rebuild_fts(self) -> None:
        with self.tx() as con:
            con.execute("DELETE FROM emails_fts")
            con.execute(f"INSERT INTO emails_fts(rowid, subject, from_name, from_addr, body) {self._FTS_SELECT}")

    # ── bulk insert (backup restore; later .eml ingest) ─────────────────────

    def add_missing_emails(self, con: sqlite3.Connection, records: list[dict]) -> list[str]:
        """Insert emails whose id isn't present (or tombstoned); returns the ids
        added. Caller owns the transaction and must rethread afterwards."""
        cols = schema.columns(EMAIL_FIELDS)
        sql = (f"INSERT OR IGNORE INTO emails({','.join(cols)}) "
               f"VALUES ({','.join('?' * len(cols))})")
        added = []
        for rec in records:
            eid = rec.get("id")
            if not isinstance(eid, str) or not eid:
                continue
            if con.execute("SELECT 1 FROM seen_ids WHERE id = ?", (eid,)).fetchone():
                continue
            row = to_row(normalize_addresses(rec), EMAIL_FIELDS,
                         skip=EMAIL_DROPPED | {k for k, _, _ in EMAIL_DERIVED})
            if con.execute(sql, [row[c] for c in cols]).rowcount:
                added.append(eid)
        return added

    def add_missing_rows(self, con: sqlite3.Connection, store: str, records: list[dict]) -> int:
        """Skip-if-existing insert for the non-email stores. Returns rows added."""
        added = 0
        if store in DOC_TABLES:
            table, kcol = DOC_TABLES[store]
            for rec in records:
                key = rec.get(kcol)
                if not isinstance(key, str) or (store == "settings" and "handle" in rec):
                    continue
                added += con.execute(f"INSERT OR IGNORE INTO {table}({kcol}, json) VALUES (?, ?)",
                                     (key, json.dumps(rec, ensure_ascii=False))).rowcount
            return added
        if store == "seenIds":
            for rec in records:
                if isinstance(rec.get("id"), str):
                    added += con.execute("INSERT OR IGNORE INTO seen_ids(id) VALUES (?)", (rec["id"],)).rowcount
            return added
        if store == "msgIndex":
            for rec in records:
                if isinstance(rec.get("messageId"), str) and isinstance(rec.get("emailId"), str):
                    added += con.execute("INSERT OR IGNORE INTO msg_index(message_id, email_id) VALUES (?, ?)",
                                         (rec["messageId"], rec["emailId"])).rowcount
            return added
        fields, table, key = {
            "attachments": (ATTACHMENT_FIELDS, "attachments", "id"),
            "tags": (TAG_FIELDS, "tags", "name"),
            "addressBook": (ADDRESS_FIELDS, "address_book", "email"),
        }[store]
        cols = schema.columns(fields)
        sql = f"INSERT OR IGNORE INTO {table}({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
        for rec in records:
            if rec.get(key) is None:
                continue
            if store == "attachments" and not con.execute(
                    "SELECT 1 FROM emails WHERE id = ?", (rec.get("emailId"),)).fetchone():
                continue  # its email was skipped (tombstoned) or never existed
            row = to_row(rec, fields)
            added += con.execute(sql, [row[c] for c in cols]).rowcount
        return added

    # ── export ──────────────────────────────────────────────────────────────

    def iter_emails_with_bodies(self) -> Iterator[dict]:
        cur = self._r().execute("SELECT e.*, b.text AS _body FROM emails e "
                               "LEFT JOIN bodies b ON b.id = e.id ORDER BY e.id")
        for r in cur:
            rec = from_row(r, EMAIL_FIELDS)
            if r["_body"]:
                rec["textBody"] = r["_body"]
            yield rec

    def iter_store(self, store: str) -> Iterator[dict]:
        if store in DOC_TABLES:
            yield from self.list_docs(store)
        elif store == "attachments":
            for r in self._r().execute("SELECT * FROM attachments ORDER BY id"):
                yield from_row(r, ATTACHMENT_FIELDS)
        elif store == "tags":
            for r in self._r().execute("SELECT * FROM tags ORDER BY name"):
                yield from_row(r, TAG_FIELDS)
        elif store == "addressBook":
            yield from self.list_contacts()
        elif store == "seenIds":
            for r in self._r().execute("SELECT id FROM seen_ids ORDER BY id"):
                yield {"id": r["id"]}
        elif store == "msgIndex":
            for r in self._r().execute("SELECT message_id, email_id FROM msg_index ORDER BY message_id"):
                yield {"messageId": r["message_id"], "emailId": r["email_id"]}
        else:
            raise KeyError(store)

    # ── stats ───────────────────────────────────────────────────────────────

    def counts(self) -> dict[str, int]:
        q = lambda sql: self._r().execute(sql).fetchone()[0]  # noqa: E731
        return {
            "emails": q("SELECT COUNT(*) FROM emails"),
            "bodies": q("SELECT COUNT(*) FROM bodies"),
            "attachments": q("SELECT COUNT(*) FROM attachments"),
            "msgIndex": q("SELECT COUNT(*) FROM msg_index"),
            "tags": q("SELECT COUNT(*) FROM tags"),
            "smartViews": q("SELECT COUNT(*) FROM smart_views"),
            "emailGroups": q("SELECT COUNT(*) FROM email_groups"),
            "settings": q("SELECT COUNT(*) FROM settings"),
            "seenIds": q("SELECT COUNT(*) FROM seen_ids"),
            "addressBook": q("SELECT COUNT(*) FROM address_book"),
            "threaded": q("SELECT COUNT(*) FROM emails WHERE thread_id IS NOT NULL AND thread_id != id"),
        }

