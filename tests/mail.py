"""Builders for raw test messages (bytes), covering the encodings and shapes
the parser has to cope with."""
from __future__ import annotations

import base64


def eml(*, mid: str | None = "m1@x", subject: str = "Hello", frm: str = "Alice <alice@corp.com>",
        to: str = "me@work.example", cc: str = "", date: str = "Tue, 03 Mar 2026 09:40:04 +0800",
        irt: str = "", refs: str = "", body: str = "Hi there", extra: str = "",
        charset: str = "utf-8") -> bytes:
    h = [f"From: {frm}", f"To: {to}", f"Subject: {subject}", f"Date: {date}"]
    if mid:
        h.append(f"Message-ID: <{mid}>")
    if cc:
        h.append(f"Cc: {cc}")
    if irt:
        h.append(f"In-Reply-To: <{irt}>")
    if refs:
        h.append(f"References: {refs}")
    if extra:
        h.append(extra)
    h += ["MIME-Version: 1.0", f"Content-Type: text/plain; charset={charset}",
          "Content-Transfer-Encoding: 8bit"]
    return ("\r\n".join(h) + "\r\n\r\n").encode("ascii") + body.encode(charset)


def multipart(*, mid: str = "mp@x", html_only: bool = False) -> bytes:
    pdf = base64.b64encode(b"%PDF-1.4 fake").decode()
    inner = (b"From: Bob <bob@corp.com>\r\nSubject: Inner\r\nMessage-ID: <inner@x>\r\n"
             b"Content-Type: multipart/mixed; boundary=IN\r\n\r\n--IN\r\nContent-Type: text/plain\r\n\r\ninner body\r\n"
             b"--IN\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"nested.pdf\"\r\n"
             b"Content-Transfer-Encoding: base64\r\n\r\n" + pdf.encode() + b"\r\n--IN--\r\n")
    alt = ("--ALT\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Only&nbsp;HTML</p><p>second para</p>\r\n--ALT--\r\n"
           if html_only else
           "--ALT\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
           "Caf=E9 plan attached.\r\n\r\nOn Mon, Bob wrote:\r\n> old\r\n"
           "--ALT\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--ALT--\r\n")
    return (
        "From: =?utf-8?B?Wm/DqyBMaW0=?= <ZOE@Corp.com>\r\n"
        "To: \"Wu, Zi Bin\" <Me@Work.example>; bob@corp.com\r\n"
        "Subject: =?utf-8?Q?Caf=C3=A9_plan?= =?utf-8?Q?_v2?=\r\n"
        f"Message-ID: <{mid}>\r\nDate: Mon, 02 Mar 2026 01:00:00 +0000\r\nMIME-Version: 1.0\r\n"
        "Content-Type: multipart/mixed; boundary=MIX\r\n\r\n"
        "--MIX\r\nContent-Type: multipart/alternative; boundary=ALT\r\n\r\n" + alt +
        "--MIX\r\nContent-Type: application/pdf; name=a.pdf\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\n"
        f"Content-Transfer-Encoding: base64\r\n\r\n{pdf}\r\n"
        "--MIX\r\nContent-Type: image/png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n"
        "--MIX\r\nContent-Type: text/calendar; name=meeting.ics\r\n\r\nBEGIN:VCALENDAR\r\n"
        "--MIX\r\nContent-Type: message/rfc822\r\n\r\n"
    ).encode("utf-8") + inner + b"--MIX--\r\n"


def mbox(*messages: tuple[bytes, int]) -> bytes:
    """Thunderbird-style mbox; each message given with its X-Mozilla-Status."""
    out = b""
    for raw, status in messages:
        out += b"From - Tue Mar 03 09:40:04 2026\r\n" + f"X-Mozilla-Status: {status:04x}\r\n".encode() + raw
        out += b"\r\n\r\n"
    return out
