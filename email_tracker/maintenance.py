"""Settings → maintenance jobs that re-run the body clean-up or detection
over the whole corpus with the current patterns (v1 ran these as cursor
passes in js/smart-views/settings.js)."""
from __future__ import annotations

from collections.abc import Callable

from .clean import CleanRules, clean_signatures, find_truncation_matches, truncate_at_line
from .detect import DetectRules, is_system_email
from .store import EmailStore


def _settings(store: EmailStore):
    return lambda k: store.get_doc("settings", k)


def _rewrite_bodies(store: EmailStore, fn: Callable[[str], str | None]) -> int:
    changed = []
    with store.tx() as con:
        for r in con.execute("SELECT id, text FROM bodies").fetchall():
            new = fn(r["text"])
            if new is not None and new != r["text"]:
                if new:
                    con.execute("UPDATE bodies SET text = ? WHERE id = ?", (new, r["id"]))
                else:
                    con.execute("DELETE FROM bodies WHERE id = ?", (r["id"],))
                changed.append(r["id"])
        store._fts_sync(con, changed)
    return len(changed)


def rerun_truncation(store: EmailStore) -> int:
    """Cut every body at its first quote/thread marker (v1's rerunTruncation)."""
    rules = CleanRules.from_settings(_settings(store))

    def fn(text: str) -> str | None:
        m = find_truncation_matches(text, rules) if text else []
        return truncate_at_line(text, m[0]) if m else None
    return _rewrite_bodies(store, fn)


def rerun_signatures(store: EmailStore) -> int:
    rules = CleanRules.from_settings(_settings(store))
    return _rewrite_bodies(store, lambda t: clean_signatures(t, rules) if t else None)


def rerun_detection(store: EmailStore) -> int:
    """Flag automated emails with the current patterns. Only ever sets the flag,
    and never on an email the user unflagged — as v1's backfill."""
    rules = DetectRules.from_settings(_settings(store))
    flagged = []
    with store.tx() as con:
        rows = con.execute(
            "SELECT e.id, e.from_addr, e.subject, COALESCE(b.text, '') AS body FROM emails e "
            "LEFT JOIN bodies b ON b.id = e.id WHERE COALESCE(e.is_system_email, 0) = 0 "
            "AND COALESCE(e.manual_system_override, 0) = 0").fetchall()
        for r in rows:
            if is_system_email({}, r["from_addr"] or "", r["subject"] or "", r["body"], rules):
                flagged.append((r["id"],))
        con.executemany("UPDATE emails SET is_system_email = 1 WHERE id = ?", flagged)
        if flagged:
            store._needs_reply(con)
    return len(flagged)
