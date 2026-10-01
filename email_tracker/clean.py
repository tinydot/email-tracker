"""Body clean-up: HTML to text, quoted-reply truncation, signature stripping.

A port of the heuristics in js/parser.js (``stripHtml``, ``isThreadMarker``,
``stripQuotedText``, ``stripSignature``, ``applySignatureRanges``), so a body
cleaned on the server matches one cleaned by v1. The user's custom patterns
come from the same settings records the Settings page edits; they are JS regex
sources, compiled here case-insensitively as v1's ``safeRegex`` did (a source
Python can't compile is skipped, as v1 skipped one JS couldn't).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

I = re.IGNORECASE

DEFAULT_SIGNATURE_PATTERNS = [
    re.compile(r"^--\s*$"),
    re.compile(r"^CONFIDENTIALITY\s*(NOTE|NOTICE)?[:\s-]", I),
    re.compile(r"^DISCLAIMER[:\s-]", I),
    re.compile(r"^This\s+(e-?mail|message|communication)\s+(and\s+any\s+attach\S*\s+)?(is|are)\s+confidential", I),
    re.compile(r"^If\s+you\s+(have\s+)?(received|are\s+not\s+the\s+intended)", I),
    re.compile(r"^Please\s+consider\s+the\s+environment\s+before\s+printing", I),
    re.compile(r"^Sent\s+from\s+my\s+(iPhone|iPad|Android|Samsung|BlackBerry|Galaxy)", I),
]

_ON_WROTE = re.compile(r"^On .+ wrote:$", I)
_ORIG_DASH = re.compile(r"^-{3,}\s*Original Message\s*-{3,}", I)
_ORIG_UNDER = re.compile(r"^_{3,}\s*Original Message\s*_{3,}", I)
_FROM = re.compile(r"^From:", I)
_SENT = re.compile(r"^Sent:", I)
_FROM_SENT_TO = re.compile(r"^From:.*Sent:.*To:", I)
_EQ_RULE = re.compile(r"^={3,}$")
_DASH_RULE = re.compile(r"^-{5,}$")
_UNDER_RULE = re.compile(r"^_{5,}$")
_FWD_BEGIN = re.compile(r"^Begin forwarded message:", I)
_FWD_DASH = re.compile(r"^-{3,}\s*Forwarded message\s*-{3,}", I)
_CJK_FROM = re.compile(r"^发件人:|^寄件者:", I)
_WHEN = re.compile(r"^When:", I)
_WHERE = re.compile(r"^Where:", I)


def compile_patterns(sources) -> list[re.Pattern]:
    out = []
    for src in sources or []:
        try:
            out.append(re.compile(src, I))
        except re.error:
            pass
    return out


@dataclass
class CleanRules:
    """The user-editable parts of body clean-up (Settings → patterns)."""
    quote_patterns: list[re.Pattern] = field(default_factory=list)
    signature_patterns: list[re.Pattern] = field(default_factory=list)
    signature_ranges: list[dict] = field(default_factory=list)

    @classmethod
    def from_settings(cls, get) -> "CleanRules":
        """``get(key)`` returns a settings record or None."""
        q = get("customQuotePatterns") or {}
        s = get("customSignaturePatterns") or {}
        r = get("signatureRanges") or {}
        return cls(compile_patterns(q.get("patterns")), compile_patterns(s.get("patterns")),
                   [x for x in (r.get("ranges") or []) if isinstance(x, dict)])


def is_thread_marker(trimmed: str, lines: list[str], i: int, rules: CleanRules) -> bool:
    nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
    return bool(
        _ON_WROTE.search(trimmed)
        or _ORIG_DASH.search(trimmed)
        or _ORIG_UNDER.search(trimmed)
        or (_FROM.search(trimmed) and i + 1 < len(lines) and lines[i + 1] and _SENT.search(nxt))
        or _FROM_SENT_TO.search(trimmed)
        or _EQ_RULE.search(trimmed)
        or _DASH_RULE.search(trimmed)
        or _UNDER_RULE.search(trimmed)
        or _FWD_BEGIN.search(trimmed)
        or _FWD_DASH.search(trimmed)
        or _CJK_FROM.search(trimmed)
        or (_WHEN.search(trimmed) and _WHERE.search(nxt))
        or any(p.search(trimmed) for p in rules.quote_patterns)
    )


def find_truncation_matches(text: str, rules: CleanRules) -> list[int]:
    lines = text.split("\n")
    return [i for i, ln in enumerate(lines) if is_thread_marker(ln.strip(), lines, i, rules)]


def truncate_at_line(text: str, line_index: int) -> str:
    return "\n".join(text.split("\n")[:line_index]).strip()


def strip_quoted_text(text: str, rules: CleanRules) -> str:
    """Keep the newest message: cut at the first thread marker, drop '>' lines."""
    lines = text.split("\n")
    kept = []
    for i, line in enumerate(lines):
        trimmed = line.strip()
        if is_thread_marker(trimmed, lines, i, rules):
            break
        if trimmed.startswith(">"):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def apply_signature_ranges(text: str, rules: CleanRules) -> str:
    if not text:
        return text
    for rng in rules.signature_ranges:
        start, end = rng.get("start") or "", rng.get("end") or ""
        if not start:
            continue
        low = text.lower()
        si = low.find(start.lower())
        if si == -1:
            continue
        if not end:
            text = text[:si].rstrip()
            continue
        ei = low.find(end.lower(), si + len(start))
        text = text[:si].rstrip() if ei == -1 else text[:si] + text[ei:]
    return text


def strip_signature(text: str, rules: CleanRules) -> str:
    """Remove the signature block — from its anchor line up to the next thread
    marker, so a quoted trail below it survives — then apply explicit ranges."""
    if not text:
        return text
    lines = text.split("\n")
    sig = -1
    for i, ln in enumerate(lines):
        t = ln.strip()
        if not t:
            continue
        if any(p.search(t) for p in DEFAULT_SIGNATURE_PATTERNS) or any(p.search(t) for p in rules.signature_patterns):
            sig = i
            break
    if sig == -1:
        return text
    quote = next((i for i in range(sig + 1, len(lines)) if is_thread_marker(lines[i].strip(), lines, i, rules)), -1)
    kept = lines[:sig] + (lines[quote:] if quote != -1 else [])
    return apply_signature_ranges("\n".join(kept).strip(), rules)


def clean_signatures(text: str, rules: CleanRules) -> str:
    """The maintenance entry point (v1's cleanSignatures): patterns, and the
    explicit ranges even when no pattern fired."""
    if not text:
        return text
    result = strip_signature(text, rules)
    if result == text:
        result = apply_signature_ranges(result, rules)
    return result


_BLANK_RUNS = re.compile(r"\n([ \t]*\n)+")


def clean_body(raw_body: str, rules: CleanRules) -> str:
    """The stored body: newest message only, signature off, blank runs collapsed."""
    if not raw_body:
        return ""
    text = strip_quoted_text(raw_body, rules) or raw_body.strip()
    no_sig = strip_signature(text, rules)
    if no_sig:
        text = no_sig
    return _BLANK_RUNS.sub("\n", text.replace("\r\n", "\n"))


# ── HTML → text (js/parser.js stripHtml) ─────────────────────────────────────

_H_DROP = [re.compile(p, re.I | re.S) for p in (
    r"<style[^>]*>.*?</style>", r"<script[^>]*>.*?</script>", r"<head[^>]*>.*?</head>", r"<!--.*?-->")]
_H_BLOCK = re.compile(r"</?(div|p|br|tr|h[1-6])[^>]*>", I)
_H_TD_END = re.compile(r"</td>", I)
_H_TD_START = re.compile(r"<td[^>]*>", I)
_H_TAG = re.compile(r"<[^>]+>")
_H_ENTITIES = [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
               ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'")]
_H_NOISE = re.compile(r"^(Use this link in|or paste this link into|Button not working\?|"
                      r"This is an automatically generated|Do not reply to this email).*$", re.I | re.M)
_H_URL = re.compile(r"https?://\S+")
_H_RULE_LINE = re.compile(r"^[\s\-_=]+$")


def strip_html(html: str) -> str:
    if not html:
        return ""
    text = html
    for p in _H_DROP:
        text = p.sub("", text)
    text = _H_BLOCK.sub("\n", text)
    text = _H_TD_END.sub(" ", text)
    text = _H_TD_START.sub("", text)
    text = _H_TAG.sub("", text)
    for ent, ch in _H_ENTITIES:
        text = re.sub(re.escape(ent), ch, text, flags=I)
    text = "\n".join(ln.strip() for ln in text.split("\n") if ln.strip())
    text = _H_URL.sub("[link]", _H_NOISE.sub("", text))
    return "\n".join(ln for ln in text.split("\n")
                     if len(ln) >= 3 and not _H_RULE_LINE.search(ln)).strip()
