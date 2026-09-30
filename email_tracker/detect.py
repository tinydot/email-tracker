"""Automated / bulk email detection — a port of js/detection.js.

Run at ingest with the message's real headers, which v1's backfill never had
(it only saw sender, subject and body). An email the user has unflagged
(``manualSystemOverride``) is never re-flagged: ingest only sets the flag on
new emails, and the maintenance re-run skips overridden ones.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .clean import compile_patterns

I = re.IGNORECASE

DEFAULT_SENDER_PATTERNS = [
    re.compile(r"^(noreply|no-reply|no\.reply|donotreply|do-not-reply|do\.not\.reply)@", I),
    re.compile(r"^(mailer-daemon|postmaster|bounce|bounces|daemon|notifications?|alerts?|automailer|auto-mailer|automated?)@", I),
]
DEFAULT_SUBJECT_PATTERNS = [
    re.compile(r"^(auto-?reply|automatic reply|out of office|undeliverable)", I),
    re.compile(r"^delivery (status notification|failure|failed)", I),
    re.compile(r"^(mail delivery (failed|failure)|returned mail|non-delivery report)", I),
    re.compile(r"^\[?(automated|auto-generated|do not reply)\]?:", I),
]
DEFAULT_BODY_PATTERNS = [
    re.compile(r"this (is an |message (was |is ))?(automated|automatically (generated|sent))", I),
    re.compile(r"do not (reply to|respond to) this (email|message)", I),
    re.compile(r"this email (was sent automatically|is automatically generated)", I),
    re.compile(r"you('re| are) receiving this (email|message|notification) because", I),
    re.compile(r"to (unsubscribe|manage your (notification|email) preferences)", I),
]


@dataclass
class DetectRules:
    senders: list[re.Pattern] = field(default_factory=lambda: list(DEFAULT_SENDER_PATTERNS))
    subjects: list[re.Pattern] = field(default_factory=lambda: list(DEFAULT_SUBJECT_PATTERNS))
    body: list[re.Pattern] = field(default_factory=lambda: list(DEFAULT_BODY_PATTERNS))

    @classmethod
    def from_settings(cls, get) -> "DetectRules":
        c = get("customAutomationPatterns") or {}
        return cls(DEFAULT_SENDER_PATTERNS + compile_patterns(c.get("senders")),
                   DEFAULT_SUBJECT_PATTERNS + compile_patterns(c.get("subjects")),
                   DEFAULT_BODY_PATTERNS + compile_patterns(c.get("body")))


def is_system_email(headers: dict[str, str], from_addr: str, subject: str, body: str,
                    rules: DetectRules) -> bool:
    """``headers`` maps lowercased names to values (empty dict if unknown)."""
    auto = headers.get("auto-submitted", "")
    if auto and auto.lower() != "no":
        return True
    if headers.get("precedence", "").lower() in ("bulk", "list", "junk"):
        return True
    for h in ("list-id", "list-unsubscribe", "x-auto-response-suppress", "feedback-id",
              "x-campaign-id", "x-campaignid"):
        if headers.get(h):
            return True
    addr = (from_addr or "").lower()
    if any(p.search(addr) for p in rules.senders):
        return True
    if any(p.search(subject or "") for p in rules.subjects):
        return True
    snippet = (body or "")[:1000]
    return any(p.search(snippet) for p in rules.body)
