"""Thread ids, persisted.

A port of ``js/threading.js``'s ``_resolveThread``: walk from an email to its
parent until there is none; the email reached is the thread root, and its id is
the ``thread_id`` of every email on the way. v1 computed this in memory on each
load and never stored it, which is why every exported row had a null thread.

One extension over v1: v1 follows only ``In-Reply-To``. Outlook often leaves
that empty (or pointing outside the corpus) while still sending ``References``
— 818 of the 11,822 replies in the 2026-09 export thread only this way — so
when ``In-Reply-To`` doesn't resolve, the parent is the nearest ``References``
entry (walking from the last) that is in the corpus.
"""
from __future__ import annotations

from collections.abc import Iterable

MAX_HOPS = 20  # v1's cap; also what stops a cycle


def parent_of(email: dict, by_msg_id: dict[str, str]) -> str | None:
    """The id of the email this one replies to, if it is in the corpus."""
    own = email["id"]
    irt = email.get("inReplyTo")
    if irt:
        pid = by_msg_id.get(irt)
        if pid and pid != own:
            return pid
    for ref in reversed(email.get("references") or []):
        pid = by_msg_id.get(ref)
        if pid and pid != own:
            return pid
    return None


def compute_thread_ids(emails: Iterable[dict]) -> dict[str, str]:
    """Map every email id to its thread root's id.

    ``emails`` need ``id``, ``messageId``, ``inReplyTo`` and ``references``.
    Where two emails share a Message-ID the later one wins, as in v1's index.
    """
    emails = list(emails)
    by_msg_id: dict[str, str] = {}
    for e in emails:
        if e.get("messageId"):
            by_msg_id[e["messageId"]] = e["id"]
    parents = {e["id"]: parent_of(e, by_msg_id) for e in emails}

    root: dict[str, str] = {}
    for e in emails:
        start = e["id"]
        if start in root:
            continue
        chain = [start]
        seen = {start}
        cur = start
        while len(chain) <= MAX_HOPS:
            if cur in root:
                break
            p = parents.get(cur)
            if p is None or p in seen:
                break
            chain.append(p)
            seen.add(p)
            cur = p
        r = root.get(cur, cur)
        for eid in chain:
            root.setdefault(eid, r)
    return root
