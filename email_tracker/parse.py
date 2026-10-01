"""Parse a raw RFC 822 message into what the tracker stores.

Replaces js/parser.js's hand-rolled MIME splitter with the stdlib ``email``
package, keeping v1's decisions about *what* counts as the body and as an
attachment. Where v1 was lossy this is deliberately cleaner:

- Text is decoded from bytes with the part's declared charset (then UTF-8,
  then cp1252), so the Latin-1 mojibake v1 needed a repair job for can't arise.
- RFC 2047 encoded words decode with their charset in both B and Q forms.
- MIME nesting is walked to any depth (v1 stopped at three levels).
- Addresses are bare and lowercased (v1 kept ``<x@y>`` when there was no name).
- Dates are ISO 8601 UTC; ids are the Message-ID, else ``sha256:<raw bytes>``;
  attachment hashes are SHA-256.
"""
from __future__ import annotations

import base64
import binascii
import email
import email.parser
import hashlib
import quopri
import re
from dataclasses import dataclass, field
from datetime import timezone
from email import policy
from email.message import Message
from email.utils import parseaddr, parsedate_to_datetime


@dataclass
class ParsedAttachment:
    filename: str
    content_type: str
    size: int
    hash: str
    content_id: str | None = None
    nested: list["ParsedAttachment"] = field(default_factory=list)


@dataclass
class ParsedEmail:
    message_id: str
    in_reply_to: str
    references: list[str]
    subject: str
    from_name: str
    from_addr: str
    to: list[str]
    cc: list[str]
    date: str | None
    raw_text_body: str          # before quote/signature clean-up
    headers: dict[str, str]     # lowercased name → first value, decoded
    attachments: list[ParsedAttachment]


def email_id(parsed: ParsedEmail, raw: bytes) -> str:
    return parsed.message_id or "sha256:" + hashlib.sha256(raw).hexdigest()


# ── text decoding ────────────────────────────────────────────────────────────

def decode_bytes(data: bytes, charset: str | None) -> str:
    for cs in (charset, "utf-8"):
        if not cs:
            continue
        try:
            return data.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("cp1252", errors="replace")


_ENCODED_WORD = re.compile(r"=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=")
_BETWEEN_WORDS = re.compile(r"(\?=)\s+(=\?)")


def decode_rfc2047(value: str) -> str:
    if "=?" not in value:
        return value
    # Whitespace between two adjacent encoded words is not part of the text.
    value = _BETWEEN_WORDS.sub(r"\1\2", value)

    def one(m: re.Match) -> str:
        charset, enc, text = m.group(1).split("*")[0], m.group(2).upper(), m.group(3)
        try:
            if enc == "B":
                data = base64.b64decode(text + "=" * (-len(text) % 4))
            else:
                data = quopri.decodestring(text.replace("_", " ").encode("ascii", "replace"), header=True)
        except (binascii.Error, ValueError):
            return m.group(0)
        return decode_bytes(data, charset)
    return _ENCODED_WORD.sub(one, value)


_FOLD = re.compile(r"\r?\n[ \t]")


def _recover_8bit(value: str) -> str:
    try:
        value.encode("ascii")
        return value
    except UnicodeEncodeError:  # raw 8-bit bytes, carried as surrogate escapes
        return decode_bytes(value.encode("ascii", "surrogateescape"), None)


def _raw_header(value: str) -> str:
    """A header value as parsed from bytes: unfold, recover 8-bit text, decode
    encoded words."""
    return decode_rfc2047(_recover_8bit(_FOLD.sub(" ", value))).strip()


def _headers(msg: Message, decode: bool = True) -> dict[str, str]:
    """First occurrence of each header (as in v1), unfolded; decoded unless
    ``decode`` is False (addresses are split before decoding)."""
    out: dict[str, str] = {}
    for name, value in msg.raw_items():
        key = name.strip().lower()
        if key not in out:
            out[key] = _raw_header(value) if decode else _FOLD.sub(" ", value).strip()
    return out


# ── ids, addresses, dates ────────────────────────────────────────────────────

_ANGLE_ID = re.compile(r"<([^<>]+)>")


_WS = re.compile(r"\s+")


def clean_msg_id(value: str) -> str:
    # Whitespace inside <...> is a folding artefact (Outlook breaks long ids).
    m = _ANGLE_ID.search(value or "")
    return _WS.sub("", m.group(1)) if m else (value or "").strip()


def msg_id_list(value: str) -> list[str]:
    ids = _ANGLE_ID.findall(value or "")
    return [_WS.sub("", i) for i in ids] if ids else [t for t in (value or "").split() if t]


def split_addresses(value: str) -> list[str]:
    """Split on ',' or ';' outside quotes and angle brackets (Outlook uses ';')."""
    parts, cur, in_angle, in_quote, esc = [], [], False, False, False
    for ch in value:
        if esc:
            esc = False
        elif ch == "\\" and in_quote:
            esc = True
        elif ch == '"' and not in_angle:
            in_quote = not in_quote
        elif ch == "<" and not in_quote:
            in_angle = True
        elif ch == ">" and not in_quote:
            in_angle = False
        if ch in ",;" and not in_angle and not in_quote:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur).strip())
    return [p for p in parts if p]


_ANGLE_ADDR = re.compile(r"<\s*([^<>\s]+@[^<>\s]+)\s*>")
_X500 = re.compile(r"/o=[^<>]+", re.I)
_BARE_ADDR = re.compile(r"[^\s<>\"',;]+@[^\s<>\"',;]+")


def parse_address(value: str) -> tuple[str, str]:
    """(display name, bare lowercase address) from one *undecoded* address, so
    an encoded display name like ``=?utf-8?Q?a=40b.com?=`` can't pose as the
    address; the name is decoded afterwards. Address '' if there is none."""
    value = value.strip()
    x500 = _X500.search(value) if "@" not in value else None
    if x500:  # an Exchange X.500 sender (PST exports of sent items): keep it as the id
        return decode_rfc2047(value[:x500.start()]).strip(' "<\'\t'), x500.group(0).strip().lower()
    name, addr = parseaddr(value)
    if "@" not in addr:
        # parseaddr gives up on e.g. ``x@y.com <x@y.com>`` (unquoted @ in the name)
        m = _ANGLE_ADDR.search(value) or _BARE_ADDR.search(value)
        if m:
            addr = m.group(1) if m.re is _ANGLE_ADDR else m.group(0)
            name = value[:m.start()].strip() if m.re is _ANGLE_ADDR else ""
        else:
            addr = ""
            name = name or value
    name = decode_rfc2047(name).strip().strip('"').strip("'").strip()
    return name, addr.strip().strip("<>").strip().lower()


def normalize_address(addr: str) -> str:
    """Bare lowercase form of a stored address (v1 sometimes kept '<x@y>')."""
    return (addr or "").strip().strip("<>").strip().lower()


def iso_date(value: str) -> str | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ── MIME walk ────────────────────────────────────────────────────────────────

def _payload_bytes(part: Message) -> bytes:
    data = part.get_payload(decode=True)
    if isinstance(data, bytes):
        return data
    raw = part.get_payload()
    return raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else b""


def _text(part: Message) -> str:
    # U+FEFF: TextDecoder dropped BOMs in v1; Outlook repeats them mid-body too.
    return decode_bytes(_payload_bytes(part), part.get_content_charset()).replace("\ufeff", "")


def _embedded(part: Message) -> Message | None:
    payload = part.get_payload()
    if isinstance(payload, list) and payload and isinstance(payload[0], Message):
        return payload[0]
    return None


def _attachment(part: Message, nested_ok: bool) -> ParsedAttachment:
    ct = part.get_content_type()
    name = part.get_filename() or part.get_param("name") or ""
    if isinstance(name, tuple):  # RFC 2231 triple
        name = email.utils.collapse_rfc2231_value(name)
    name = decode_rfc2047(str(name)).strip()
    inner = _embedded(part) if ct == "message/rfc822" else None
    if inner is not None:
        try:
            data = inner.as_bytes()
        except Exception:  # noqa: BLE001 — a broken embedded message is still an attachment
            data = str(inner).encode("utf-8", "surrogateescape")
        if not name:
            subj = _raw_header(inner.get("Subject", "") or "")
            name = f"{subj}.eml" if subj else "forwarded-message.eml"
    else:
        data = _payload_bytes(part)
    cid = (part.get("Content-ID") or "").strip().strip("<>").strip() or None
    att = ParsedAttachment(filename=name or "attachment", content_type=ct, size=len(data),
                           hash=hashlib.sha256(data).hexdigest(), content_id=cid)
    if inner is not None and nested_ok:
        body = _Body()
        _walk(inner, body, nested_ok=False)
        att.nested = body.attachments
    return att


@dataclass
class _Body:
    text: str = ""
    html: str = ""
    attachments: list[ParsedAttachment] = field(default_factory=list)


def _walk(part: Message, out: _Body, nested_ok: bool, root: bool = False) -> None:
    ct = part.get_content_type()
    if ct == "message/rfc822" and not root:
        out.attachments.append(_attachment(part, nested_ok))
        return
    if part.is_multipart():
        for sub in part.get_payload():
            if isinstance(sub, Message):
                _walk(sub, out, nested_ok)
        return
    if root:  # a single-part message is its body
        if ct == "text/html":
            out.html = _text(part)
        else:
            out.text = _text(part)
        return
    cd = (part.get("Content-Disposition") or "").lower()
    # Only a *disposition* filename counts (v1's rule): Content-Type name= alone
    # is how calendar replies label meeting.ics, which isn't a user attachment.
    has_name = bool(part.get_param("filename", header="content-disposition"))
    # v1's rule: a filename (even on an "inline" part — Outlook does that), an
    # explicit attachment, or an image with a Content-ID is an attachment.
    if "attachment" in cd or has_name or (part.get("Content-ID") and ct.startswith("image/")):
        out.attachments.append(_attachment(part, nested_ok))
    elif ct == "text/plain":
        if not out.text:
            out.text = _text(part)
    elif ct == "text/html":
        if not out.html:
            out.html = _text(part)
    elif not ct.startswith("text/") and not ct.startswith("image/"):
        out.attachments.append(_attachment(part, nested_ok))


def peek_headers(raw: bytes) -> tuple[str, str]:
    """(Message-ID, sender address) from the header block alone — cheap enough
    to settle an already-imported message without a full parse."""
    end = raw.find(b"\r\n\r\n")
    end2 = raw.find(b"\n\n")
    cut = min(x for x in (end, end2, len(raw)) if x != -1)
    msg = email.parser.BytesHeaderParser(policy=policy.compat32).parsebytes(raw[:cut] + b"\n\n")
    h = _headers(msg, decode=False)
    return clean_msg_id(h.get("message-id", "")), parse_address(_recover_8bit(h.get("from", "")))[1]


def parse_message(raw: bytes) -> ParsedEmail:
    from .clean import strip_html
    msg = email.message_from_bytes(raw, policy=policy.compat32)
    headers = _headers(msg)
    undecoded = _headers(msg, decode=False)
    body = _Body()
    _walk(msg, body, nested_ok=True, root=True)
    raw_text = (body.text or (strip_html(body.html) if body.html else "")).replace("\r\n", "\n")
    from_name, from_addr = parse_address(_recover_8bit(undecoded.get("from", "")))

    def addrs(key: str) -> list[str]:
        out = []
        for p in split_addresses(_recover_8bit(undecoded.get(key, ""))):
            a = parse_address(p)[1]
            if a and a not in out:
                out.append(a)
        return out

    return ParsedEmail(
        message_id=clean_msg_id(headers.get("message-id", "")),
        in_reply_to=clean_msg_id(headers.get("in-reply-to", "")),
        references=msg_id_list(headers.get("references", "")),
        subject=headers.get("subject") or "(no subject)",
        from_name=from_name,
        from_addr=from_addr,
        to=addrs("to"),
        cc=addrs("cc"),
        date=iso_date(headers.get("date", "")),
        raw_text_body=raw_text,
        headers=headers,
        attachments=body.attachments,
    )
