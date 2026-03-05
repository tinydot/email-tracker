#!/usr/bin/env python3
"""
pst_to_eml.py — Export all emails from an Outlook .pst file as .eml files.

Requires:  pip install pywin32
Usage:     python pst_to_eml.py "C:\\Backup\\archive.pst" "C:\\emails-export"

Strategy:
  1. Try item.SaveAs(path, 1024) — works on some Outlook versions
  2. Fallback: reconstruct a valid .eml from MAPI properties (works everywhere)
"""

import sys
import os
import re
import tempfile
import argparse
import datetime
import email.utils
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

try:
    import win32com.client
except ImportError:
    sys.exit("Missing dependency.\nRun:  pip install pywin32")

# ── Outlook COM constants ──────────────────────────────────────────────────────
OL_MAIL_CLASS   = 43    # OlObjectClass.olMail
OL_RFC822       = 1024  # OlSaveAsType — may not be available on all versions
OL_BY_VALUE     = 1     # OlAttachmentType.olByValue (real file attachment)

# ── MAPI property URNs (for PropertyAccessor) ─────────────────────────────────
_P = "http://schemas.microsoft.com/mapi/proptag/"
PROP_TRANSPORT_HEADERS = _P + "0x007D001E"   # original internet headers
PROP_MESSAGE_ID        = _P + "0x1035001E"   # Message-ID
PROP_IN_REPLY_TO       = _P + "0x1042001E"   # In-Reply-To
PROP_REFERENCES        = _P + "0x1039001E"   # References
PROP_ATTACH_CONTENT_ID = _P + "0x3712001E"   # attachment Content-ID (inline images)
PROP_ATTACH_MIME_TAG   = _P + "0x370E001E"   # attachment MIME type


# ── Helpers ───────────────────────────────────────────────────────────────────

def mapi_get(item, prop_urn: str) -> str:
    """Read a string MAPI property; return '' on any error."""
    try:
        v = item.PropertyAccessor.GetProperty(prop_urn)
        return v if isinstance(v, str) else ""
    except Exception:
        return ""


def parse_header(raw: str, name: str) -> str:
    """Extract one header value from a raw RFC 2822 header block."""
    m = re.search(
        rf"^{re.escape(name)}:\s*(.+?)(?=\r?\n(?!\s)|\Z)",
        raw, re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    if not m:
        return ""
    return re.sub(r"\r?\n\s+", " ", m.group(1)).strip()


def fmt_date(item) -> str:
    try:
        dt = item.ReceivedTime
        if dt is None:
            return ""
        if getattr(dt, "tzinfo", None) is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return email.utils.format_datetime(dt)
    except Exception:
        return ""


def sanitize(name: str, max_len: int = 80) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "no-subject")
    return name[:max_len].strip() or "no-subject"


# ── EML builder (fallback) ────────────────────────────────────────────────────

def read_attachment(att, index: int):
    """
    Read one Outlook attachment into a dict:
      { fname, data, content_id, mime_type, inline }
    Returns None if the attachment can't be read.
    """
    try:
        if att.Type != OL_BY_VALUE:
            return None
        fname      = att.FileName or f"attachment_{index}"
        content_id = mapi_get(att, PROP_ATTACH_CONTENT_ID).strip("<>")
        mime_type  = mapi_get(att, PROP_ATTACH_MIME_TAG) or "application/octet-stream"

        suffix = os.path.splitext(fname)[1] or ".bin"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
        att.SaveAsFile(tmp_path)
        with open(tmp_path, "rb") as fh:
            data = fh.read()
        os.unlink(tmp_path)

        return {
            "fname":      fname,
            "data":       data,
            "content_id": content_id,   # non-empty → inline image
            "mime_type":  mime_type,
            "inline":     bool(content_id),
        }
    except Exception:
        return None


def make_att_part(info: dict) -> MIMEBase:
    """Build a MIME part for a file attachment (Content-Disposition: attachment)."""
    main, _, sub = info["mime_type"].partition("/")
    part = MIMEBase(main or "application", sub or "octet-stream")
    part.set_payload(info["data"])
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", "attachment", filename=info["fname"])
    return part


def make_inline_part(info: dict) -> MIMEBase:
    """Build a MIME part for an inline image (Content-Disposition: inline + Content-ID)."""
    main, _, sub = info["mime_type"].partition("/")
    part = MIMEBase(main or "image", sub or "octet-stream")
    part.set_payload(info["data"])
    encoders.encode_base64(part)
    part.add_header("Content-ID", f"<{info['content_id']}>")
    part.add_header("Content-Disposition", "inline", filename=info["fname"])
    return part


def build_eml(item) -> bytes:
    """
    Construct a valid MIME .eml from an Outlook MailItem COM object.

    Correct MIME structure for emails with inline images:

      multipart/mixed                 ← only if file attachments exist
        multipart/alternative         ← only if both text + html exist
          text/plain
          multipart/related           ← only if inline images exist
            text/html
            image/* (Content-ID)      ← inline images
        application/* (attachment)    ← file attachments
    """
    transport = mapi_get(item, PROP_TRANSPORT_HEADERS)

    # Threading headers — MAPI props are most reliable; fall back to transport block
    msg_id   = mapi_get(item, PROP_MESSAGE_ID)   or parse_header(transport, "Message-ID")
    in_reply = mapi_get(item, PROP_IN_REPLY_TO)  or parse_header(transport, "In-Reply-To")
    refs     = mapi_get(item, PROP_REFERENCES)   or parse_header(transport, "References")

    from_name = getattr(item, "SenderName", "")          or ""
    from_addr = getattr(item, "SenderEmailAddress", "")  or ""
    to_str    = getattr(item, "To", "")                  or ""
    cc_str    = getattr(item, "CC", "")                  or ""
    subject   = getattr(item, "Subject", "")             or ""
    body_text = getattr(item, "Body", "")                or ""
    html_body = getattr(item, "HTMLBody", "")            or ""
    date_str  = fmt_date(item)

    # ── Classify attachments ───────────────────────────────────────────────────
    inline_atts = []   # embedded images (have Content-ID)
    file_atts   = []   # regular file attachments

    for k in range(1, item.Attachments.Count + 1):
        info = read_attachment(item.Attachments.Item(k), k)
        if info is None:
            continue
        if info["inline"]:
            inline_atts.append(info)
        else:
            file_atts.append(info)

    # ── Build body section ─────────────────────────────────────────────────────
    text_part = MIMEText(body_text, "plain", "utf-8")

    if html_body:
        html_part = MIMEText(html_body, "html", "utf-8")

        if inline_atts:
            # Wrap HTML + inline images in multipart/related
            related = MIMEMultipart("related")
            related.attach(html_part)
            for info in inline_atts:
                related.attach(make_inline_part(info))
            html_section = related
        else:
            html_section = html_part

        # Offer both plain-text and HTML alternatives
        body_section = MIMEMultipart("alternative")
        body_section.attach(text_part)
        body_section.attach(html_section)
    else:
        body_section = text_part

    # ── Wrap with file attachments if any ─────────────────────────────────────
    if file_atts:
        root = MIMEMultipart("mixed")
        root.attach(body_section)
        for info in file_atts:
            root.attach(make_att_part(info))
    else:
        root = body_section

    # ── Set envelope headers ───────────────────────────────────────────────────
    from_str = (
        f"{from_name} <{from_addr}>" if from_name and from_addr
        else from_addr or from_name or "unknown"
    )
    root["From"]    = from_str
    root["To"]      = to_str
    if cc_str:
        root["CC"]  = cc_str
    root["Subject"] = subject
    if date_str:
        root["Date"] = date_str
    if msg_id:
        root["Message-ID"]  = msg_id
    if in_reply:
        root["In-Reply-To"] = in_reply
    if refs:
        root["References"]  = refs

    return root.as_bytes()


# ── Export logic ──────────────────────────────────────────────────────────────

def export_folder(folder, out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    saved = errors = 0
    items = folder.Items
    total = items.Count
    folder_name = folder.Name

    # Print folder header before processing (visible immediately)
    print(f"  Folder: {folder_name} ({total} items)")

    for i in range(1, total + 1):
        try:
            item = items.Item(i)
        except Exception:
            errors += 1
            continue

        if item.Class != OL_MAIL_CLASS:
            continue

        uid      = (item.EntryID or "")[-8:] or f"{i:04d}"
        filename = f"{sanitize(item.Subject)}_{uid}.eml"
        filepath = os.path.join(out_dir, filename)
        if len(filepath) > 250:
            filepath = os.path.join(out_dir, f"email_{uid}.eml")

        ok = False

        # ── Attempt 1: native SaveAs (fast, lossless) ─────────────────────────
        try:
            item.SaveAs(filepath, OL_RFC822)
            ok = True
        except Exception:
            pass

        # ── Attempt 2: reconstruct from MAPI properties ───────────────────────
        if not ok:
            try:
                data = build_eml(item)
                with open(filepath, "wb") as fh:
                    fh.write(data)
                ok = True
            except Exception as exc:
                errors += 1

        if ok:
            saved += 1

        # Overwrite the same line with a running counter
        print(f"    [{i}/{total}] {saved} saved, {errors} failed\r", end="", flush=True)

    # Final summary line for this folder (overwrites the progress counter)
    label = f"  {saved:4d} saved"
    if errors:
        label += f", {errors} failed"
    print(f"{label}  →  {out_dir}" + " " * 20)

    for j in range(1, folder.Folders.Count + 1):
        try:
            sub = folder.Folders.Item(j)
            saved += export_folder(sub, os.path.join(out_dir, sanitize(sub.Name)))
        except Exception as exc:
            print(f"  [folder error] {exc}")

    return saved


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Export Outlook PST → .eml files")
    ap.add_argument("pst",    help="Path to .pst file")
    ap.add_argument("output", help="Output directory for .eml files")
    args = ap.parse_args()

    pst_path = os.path.abspath(args.pst)
    out_path = os.path.abspath(args.output)

    if not os.path.isfile(pst_path):
        sys.exit(f"PST file not found: {pst_path}")

    print("Connecting to Outlook COM …")
    outlook = win32com.client.Dispatch("Outlook.Application")
    ns      = outlook.GetNamespace("MAPI")

    print(f"Adding PST: {pst_path}")
    ns.AddStore(pst_path)

    store = next(
        (s for s in ns.Stores if s.FilePath.lower() == pst_path.lower()), None
    )
    if not store:
        sys.exit("Could not open PST store. Is the file open/locked by Outlook?")

    root  = store.GetRootFolder()
    print(f"Exporting '{root.Name}'  →  {out_path}\n")
    total = export_folder(root, out_path)

    ns.RemoveStore(root)

    print(f"\n{'─' * 50}")
    print(f"Done — {total} email(s) exported.")
    print(f"Drop  '{out_path}'  into the email-tracker import panel.")


if __name__ == "__main__":
    main()
