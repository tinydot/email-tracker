import os

import pytest

from email_tracker.ingest import Ingestor, ingest_paths, reparse
from email_tracker.mbox import default_profile, find_mbox_files, scan_profile
from email_tracker.store import EmailStore
from tests.mail import eml, mbox, multipart

ME = "me@work.example"


@pytest.fixture
def ing(tmp_path):
    s = EmailStore(tmp_path / "email.db", my_addresses=[ME])
    yield Ingestor(s, tmp_path / "eml")
    s.close()


def ingest(ing, *raws):
    with ing.batch() as b:
        return [b.add(r, f"m{i}.eml") for i, r in enumerate(raws)]


def test_ingest_records_everything(ing):
    assert ingest(ing, multipart()) == ["added"]
    s = ing.store
    e = s.get_email("mp@x")
    assert e["subject"] == "Café plan v2" and e["fromAddr"] == "zoe@corp.com"
    assert e["attachmentCount"] == 3 and e["hasAttachments"] is True
    assert e["status"] == "unread" and e["isSystemEmail"] is False
    assert s.get_body("mp@x") == "Café plan attached."
    atts = {a["id"]: a for a in s.list_attachments("mp@x")}
    assert "mp@x::Inner.eml::nested.pdf" in atts and atts["mp@x::Inner.eml::nested.pdf"]["isNested"]
    path = ing.archived_path(e["emlArchivePath"])
    assert path and path.read_bytes() == multipart() and e["emlArchivePath"].startswith("corp.com/")
    assert s.con.execute("SELECT count(*) FROM emails_fts WHERE emails_fts MATCH 'plan'").fetchone()[0] == 1


def test_reingest_is_noop_and_keeps_user_state(ing):
    ingest(ing, eml())
    ing.store.patch_email("m1@x", {"tags": ["keep"], "status": "read"})
    assert ingest(ing, eml(subject="changed")) == ["existing"]
    e = ing.store.get_email("m1@x")
    assert e["tags"] == ["keep"] and e["subject"] == "Hello"


def test_tombstoned_stays_out(ing):
    ing.store.con.execute("INSERT INTO seen_ids(id) VALUES ('m1@x')")
    assert ingest(ing, eml()) == ["tombstoned"]
    assert ing.store.counts()["emails"] == 0


def test_existing_without_original_gets_archived(ing):
    with ing.store.tx() as con:
        ing.store.add_missing_emails(con, [{"id": "m1@x", "messageId": "m1@x", "subject": "from v1"}])
    assert ingest(ing, eml()) == ["archived"]
    e = ing.store.get_email("m1@x")
    assert e["subject"] == "from v1" and ing.archived_path(e["emlArchivePath"])


def test_detection_uses_real_headers(ing):
    ingest(ing, eml(mid="auto@x", extra="List-Unsubscribe: <mailto:x>"))
    assert ing.store.get_email("auto@x")["isSystemEmail"] is True


def test_failed_message_does_not_stop_batch(ing, monkeypatch):
    import email_tracker.ingest as mod
    real = mod.parse_message

    def flaky(raw):
        if b"boom" in raw:
            raise ValueError("boom")
        return real(raw)
    monkeypatch.setattr(mod, "parse_message", flaky)
    with ing.batch() as b:
        assert b.add(eml(mid="a@x"), "a.eml") == "added"
        assert b.add(eml(mid=None, body="boom"), "bad.eml") == "failed"
        assert b.add(eml(mid="c@x"), "c.eml") == "added"
    assert ing.store.counts()["emails"] == 2 and b.result.errors[0].startswith("bad.eml")


def test_folder_ingest_hard_links(ing, tmp_path):
    src = tmp_path / "src" / "sub"
    src.mkdir(parents=True)
    (src / "one.eml").write_bytes(eml(mid="one@x"))
    (src / "note.txt").write_text("ignored")
    res = ingest_paths(ing, [tmp_path / "src"])
    assert res.added == 1
    arch = ing.archived_path(ing.store.get_email("one@x")["emlArchivePath"])
    assert os.stat(arch).st_ino == os.stat(src / "one.eml").st_ino


def test_threads_and_needs_reply(ing):
    ingest(ing,
           eml(mid="t1@x", frm="a@corp.com", to=ME),
           eml(mid="t2@x", frm=ME, to="a@corp.com", irt="t1@x", date="Wed, 04 Mar 2026 09:00:00 +0800"),
           # Outlook-style reply: References only; newest, to me → waiting on me
           eml(mid="t3@x", frm="a@corp.com", to=ME, refs="<t1@x> <t2@x>", date="Thu, 05 Mar 2026 09:00:00 +0800"),
           # broadcast from a stranger to many: listed, not waiting
           eml(mid="b1@x", frm="x@other.com", to=f"{ME}, p@x.com, q@x.com, r@x.com"),
           # direct note from someone I've written to: waiting
           eml(mid="d1@x", frm="a@corp.com", to=ME, subject="Quick question"),
           # calendar response: never waiting
           eml(mid="c1@x", frm="a@corp.com", to=ME, subject="Accepted: Meeting"))
    s = ing.store
    by = {e["id"]: e for e in s.list_emails()}
    assert by["t3@x"]["threadId"] == "t1@x" and by["t2@x"]["threadId"] == "t1@x"
    flagged = sorted(i for i, e in by.items() if e.get("needsMyReply"))
    assert flagged == ["d1@x", "t3@x"]
    # I reply: the thread is no longer waiting
    ingest(ing, eml(mid="t4@x", frm=ME, to="a@corp.com", irt="t3@x", date="Fri, 06 Mar 2026 09:00:00 +0800"))
    assert not s.get_email("t3@x").get("needsMyReply")


def test_needs_reply_off_without_my_addresses(tmp_path):
    s = EmailStore(tmp_path / "e.db")
    ing = Ingestor(s, tmp_path / "eml")
    ingest(ing, eml(frm="a@corp.com", to=ME))
    assert not s.get_email("m1@x").get("needsMyReply")
    s.close()


def test_reparse_returns_raw_body_and_adds_missing_attachments(ing):
    ingest(ing, multipart())
    ing.store.con.execute("DELETE FROM attachments WHERE id = 'mp@x::a.pdf'")
    r = reparse(ing, "mp@x")
    assert "On Mon, Bob wrote:" in r["rawTextBody"]
    assert r["attachmentsAdded"] == 1


def _profile(tmp_path, content: bytes):
    acct = tmp_path / "prof" / "ImapMail" / "acct"
    (acct / "Thunderbird.sbd").mkdir(parents=True)
    (acct / "INBOX").write_bytes(content)
    (acct / "INBOX.msf").write_bytes(b"")
    (acct / "Trash").write_bytes(mbox((eml(mid="trash@x"), 0)))
    (acct / "Trash.msf").write_bytes(b"")
    (acct / "Thunderbird.sbd" / "Sep 3").write_bytes(mbox((eml(mid="sep@x"), 0)))
    (acct / "Thunderbird.sbd" / "Sep 3.msf").write_bytes(b"")
    return tmp_path / "prof"


def test_thunderbird_scan(ing, tmp_path):
    body = "Line\r\n>From the escaped line\r\nend"
    prof = _profile(tmp_path, mbox((eml(mid="a@x", body=body), 0), (eml(mid="gone@x"), 0x0008),
                                   (eml(mid="b@x"), 0x0001)))
    labels = [f.label for f in find_mbox_files(prof)]
    assert labels == ["acct/INBOX", "acct/Thunderbird/Sep 3", "acct/Trash"]
    res = scan_profile(ing, prof)
    assert (res.added, res.expunged, res.messages, res.skipped_folders) == (3, 1, 4, ["acct/Trash"])
    ids = {e["id"] for e in ing.store.list_emails()}
    assert ids == {"a@x", "b@x", "sep@x"}
    assert ing.store.get_body("a@x").startswith("Line")

    # rescan: nothing new; then Thunderbird appends a message
    assert scan_profile(ing, prof).added == 0
    inbox = prof / "ImapMail" / "acct" / "INBOX"
    with open(inbox, "ab") as fh:
        fh.write(mbox((eml(mid="new@x"), 0)))
    res = scan_profile(ing, prof)
    assert res.added == 1 and res.messages == 1   # resumed at the old end


def test_thunderbird_compaction_rescans(ing, tmp_path):
    prof = _profile(tmp_path, mbox((eml(mid="a@x"), 0), (eml(mid="b@x"), 0)))
    scan_profile(ing, prof)
    inbox = prof / "ImapMail" / "acct" / "INBOX"
    inbox.write_bytes(mbox((eml(mid="c@x"), 0)))   # compacted + new: shorter file
    res = scan_profile(ing, prof)
    assert res.added == 1 and "c@x" in {e["id"] for e in ing.store.list_emails()}


def test_default_profile_reads_profiles_ini(tmp_path):
    root = tmp_path / "Thunderbird"
    (root / "Profiles" / "abc.default-release" / "ImapMail").mkdir(parents=True)
    (root / "profiles.ini").write_text("[Install1]\nDefault=Profiles/abc.default-release\n")
    assert default_profile(root) == root / "Profiles" / "abc.default-release"


def test_migration_normalizes_old_addresses(tmp_path):
    import sqlite3
    db = tmp_path / "old.db"
    s = EmailStore(db)
    with s.tx() as con:
        s.add_missing_emails(con, [{"id": "x", "subject": "s"}])
        con.execute("UPDATE emails SET from_addr = '<Bob@Corp.com>', to_addrs = '[\"<A@b.com>\", \"a@b.com\", \"\"]'")
        con.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
        con.execute("ALTER TABLE emails DROP COLUMN needs_my_reply")
    s.close()
    s = EmailStore(db, my_addresses=[ME])
    e = s.get_email("x")
    assert e["fromAddr"] == "bob@corp.com" and e["toAddrs"] == ["a@b.com"]
    assert s.meta("schema_version") == "2"
    assert s.rederive_if_pending() is True
    s.close()
    assert sqlite3.connect(db).execute("SELECT count(*) FROM pragma_table_info('emails') "
                                       "WHERE name = 'needs_my_reply'").fetchone()[0] == 1


def test_automated_mail_keeps_no_original(ing):
    assert ingest(ing, eml(mid="auto@x", frm="noreply@bentley.com")) == ["added"]
    e = ing.store.get_email("auto@x")
    assert e["isSystemEmail"] is True and "emlArchivePath" not in e
    assert not (ing.archive_dir / "bentley.com").exists()
    # re-importing it doesn't archive it either
    assert ingest(ing, eml(mid="auto@x", frm="noreply@bentley.com")) == ["existing"]
    assert "emlArchivePath" not in ing.store.get_email("auto@x")


def test_purge_automated_originals(ing):
    ingest(ing, eml(mid="p@x"), eml(mid="q@x", frm="bob@corp.com"))
    p_path = ing.archived_path(ing.store.get_email("p@x")["emlArchivePath"])
    q_path = ing.archived_path(ing.store.get_email("q@x")["emlArchivePath"])
    ing.store.patch_email("p@x", {"isSystemEmail": True})
    r = ing.purge_automated_originals()
    assert r == {"emails": 1, "files": 1, "bytesFreed": len(eml(mid="p@x"))}
    assert not p_path.exists() and q_path.exists()
    assert "emlArchivePath" not in ing.store.get_email("p@x")
    assert ing.purge_automated_originals()["files"] == 0
