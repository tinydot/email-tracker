from email_tracker.clean import CleanRules, clean_body, compile_patterns, strip_html
from email_tracker.detect import DetectRules, is_system_email
from email_tracker.parse import email_id, parse_address, parse_message
from tests.mail import eml, multipart


def test_multipart_structure_and_decoding():
    p = parse_message(multipart())
    assert p.subject == "Café plan v2"            # adjacent encoded words, whitespace dropped
    assert p.from_name == "Zoë Lim" and p.from_addr == "zoe@corp.com"
    assert p.to == ["me@work.example", "bob@corp.com"]   # ';' separator, quoted comma kept
    assert p.date == "2026-03-02T01:00:00.000Z"
    assert p.raw_text_body.startswith("Café plan attached.")   # QP + iso-8859-1, no mojibake
    names = [a.filename for a in p.attachments]
    # the CID image counts; meeting.ics (Content-Type name only) does not
    assert names == ["a.pdf", "attachment", "Inner.eml"]
    fwd = p.attachments[2]
    assert fwd.content_type == "message/rfc822"
    assert [n.filename for n in fwd.nested] == ["nested.pdf"]
    assert len(p.attachments[0].hash) == 64       # sha256


def test_clean_body_truncates_quote():
    p = parse_message(multipart())
    assert clean_body(p.raw_text_body, CleanRules()) == "Café plan attached."


def test_html_only_falls_back_to_text():
    p = parse_message(multipart(html_only=True))
    assert p.raw_text_body == "Only HTML\nsecond para"


def test_missing_message_id_gets_sha256_id():
    raw = eml(mid=None)
    p = parse_message(raw)
    assert p.message_id == ""
    eid = email_id(p, raw)
    assert eid.startswith("sha256:") and len(eid) == 7 + 64
    assert email_id(parse_message(raw), raw) == eid


def test_folded_message_ids_lose_whitespace():
    raw = eml(refs="<a@x>\r\n <JH0P R06MB@outlook.com> <c@x>")
    assert parse_message(raw).references == ["a@x", "JH0PR06MB@outlook.com", "c@x"]


def test_latin1_declared_utf8_falls_back():
    raw = eml(body="naïve café", charset="latin-1").replace(b"charset=latin-1", b"charset=utf-8")
    assert parse_message(raw).raw_text_body == "naïve café"


def test_bom_removed_and_bad_date():
    raw = eml(body="﻿Hello", date="not a date")
    p = parse_message(raw)
    assert p.raw_text_body == "Hello" and p.date is None


def test_addresses():
    assert parse_address("x@y.com <X@Y.com>") == ("x@y.com", "x@y.com")
    assert parse_address("=?utf-8?Q?a=40b.com?= <A@b.com>") == ("a@b.com", "a@b.com")
    assert parse_address('"Pat Example" </o=ExchangeLabs/ou=X (Y)/cn=z>')[1] == "/o=exchangelabs/ou=x (y)/cn=z"
    assert parse_address("Name only") == ("Name only", "")
    p = parse_message(eml(to='"a \\"q\\" b" <a@x.com>, c@x.com'))
    assert p.to == ["a@x.com", "c@x.com"]


def test_signature_and_custom_patterns():
    rules = CleanRules(quote_patterns=compile_patterns(["^=== reply ==="]),
                       signature_patterns=compile_patterns(["^Best,"]),
                       signature_ranges=[{"start": "[tag", "end": "tag]"}])
    text = "Body [tag noise tag] end\nBest,\nAlice\n=== reply ===\nold stuff"
    assert clean_body(text, rules) == "Body tag] end"
    assert compile_patterns(["(unclosed"]) == []


def test_strip_html_entities_and_links():
    assert strip_html("<p>a &amp; b</p><p>see https://x.com/y</p>") == "a & b\nsee [link]"


def test_detection():
    r = DetectRules()
    assert is_system_email({"list-id": "x"}, "a@b.com", "hi", "", r)
    assert is_system_email({"auto-submitted": "auto-generated"}, "a@b.com", "", "", r)
    assert not is_system_email({"auto-submitted": "no"}, "a@b.com", "", "", r)
    assert is_system_email({}, "noreply@bentley.com", "", "", r)
    assert is_system_email({}, "a@b.com", "Automatic reply: away", "", r)
    assert not is_system_email({}, "a@b.com", "Lunch?", "hi", r)
    custom = DetectRules.from_settings(lambda k: {"senders": ["^pw@"]} if k == "customAutomationPatterns" else None)
    assert is_system_email({}, "pw@corp.com", "", "", custom)
