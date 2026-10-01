import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from email_tracker.config import Config
from email_tracker.server import create_app
from tests.fixtures import backup_text

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def client(loaded, tmp_path):
    cfg = Config(db_path=loaded.path)
    with TestClient(create_app(cfg, loaded), base_url="http://127.0.0.1") as c:
        yield c


def u(email_id):
    return quote(email_id, safe="")


def test_index_injects_flag_and_serves_assets(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "window.EMAIL_V2_SERVER = true" in r.text
    assert r.text.index("EMAIL_V2_SERVER") < r.text.index('src="js/db.js"')
    assert client.get("/js/api.js").status_code == 200
    assert client.get("/css/styles.css").status_code == 200


def test_list_emails_has_no_bodies(client):
    emails = client.get("/api/emails").json()
    assert len(emails) == 5
    assert all("textBody" not in e for e in emails)
    assert {e["id"]: e["threadId"] for e in emails}["r2@x"] == "root@x"


def test_patch_whitelist(client):
    r = client.patch(f"/api/emails/{u('root@x')}/fields",
                     json={"status": "read", "tags": ["x"], "subject": "hacked", "threadId": "no"})
    assert r.status_code == 200
    e = r.json()
    assert e["status"] == "read" and e["tags"] == ["x"]
    assert e["subject"] == "Subject root" and e["threadId"] == "root@x"
    assert client.patch(f"/api/emails/{u('nope')}/fields", json={}).status_code == 404


def test_ids_with_slashes_and_specials(client, loaded):
    weird = "!&!AAAA/Rb7+WOk==@capitalcranes.com.sg"
    with loaded.tx() as con:
        loaded.add_missing_emails(con, [{"id": weird, "messageId": weird, "subject": "w"}])
    r = client.patch(f"/api/emails/{u(weird)}/fields", json={"status": "read"})
    assert r.status_code == 200 and r.json()["id"] == weird
    assert client.put(f"/api/emails/{u(weird)}/body", json={"text": "hi"}).status_code == 200
    assert client.get(f"/api/emails/{u(weird)}/body").json()["text"] == "hi"


def test_body_roundtrip_and_empty_deletes(client, loaded):
    assert client.get(f"/api/emails/{u('r1@x')}/body").json()["text"] == "Reply one"
    client.put(f"/api/emails/{u('r1@x')}/body", json={"text": "Edited Quokka"})
    assert client.get("/api/search/bodies", params={"q": "quokka"}).json() == ["r1@x"]
    client.put(f"/api/emails/{u('r1@x')}/body", json={"text": ""})
    assert loaded.counts()["bodies"] == 3
    fts = loaded.con.execute("SELECT count(*) FROM emails_fts WHERE emails_fts MATCH 'Quokka'").fetchone()[0]
    assert fts == 0


def test_search_is_unicode_case_insensitive(client):
    assert client.get("/api/search/bodies", params={"q": "zürich"}).json() == ["r2@x"]
    assert client.get("/api/search/bodies", params={"q": "ZÜRICH"}).json() == ["r2@x"]


def test_bodies_batch(client):
    got = client.post("/api/bodies", json={"ids": ["root@x", "orphan@x", "r1@x"]}).json()
    assert {g["id"] for g in got} == {"root@x", "r1@x"}


def test_delete_email_cascades_without_tombstone(client, loaded):
    assert client.delete(f"/api/emails/{u('sys@x')}/record").status_code == 200
    assert loaded.counts()["attachments"] == 0
    assert not loaded.is_tombstoned("sys@x")
    assert client.delete(f"/api/emails/{u('sys@x')}/record").status_code == 404


def test_discard_automated_tombstones(client, loaded):
    client.patch(f"/api/emails/{u('orphan@x')}/fields",
                 json={"isSystemEmail": True, "manualSystemOverride": False})
    client.patch(f"/api/emails/{u('root@x')}/fields",
                 json={"isSystemEmail": False, "manualSystemOverride": True})
    ids = client.post("/api/emails/discard-automated").json()["discarded"]
    assert sorted(ids) == ["orphan@x", "sys@x"]
    assert loaded.is_tombstoned("sys@x")
    # re-importing the backup does not bring them back
    r = client.post("/api/import-backup", content=backup_text(), headers=JSON).json()
    assert r["added"]["emails"] == 0
    assert "sys@x" not in {e["id"] for e in client.get("/api/emails").json()}


def test_attachments(client):
    light = client.get("/api/attachments").json()
    assert light and "extractedText" not in light[0]
    full = client.get(f"/api/emails/{u('sys@x')}/attachments").json()
    assert full[0]["extractedText"] == "pdf text" and full[0]["extractedAt"] == 1756000000000
    t = client.post(f"/api/attachments/{u('sys@x::a.pdf')}/toggle-blacklist").json()
    assert t["isBlacklisted"] is True
    t = client.post(f"/api/attachments/{u('sys@x::a.pdf')}/toggle-blacklist").json()
    assert t["isBlacklisted"] is False


def test_docs_settings_contacts(client):
    sv = {"id": "sv-2", "name": "New", "groups": [], "groupOperator": "AND"}
    assert client.put("/api/smart-views/sv-2", json=sv).json() == sv
    assert {s["id"] for s in client.get("/api/smart-views").json()} == {"sv-1", "sv-2"}
    assert client.put("/api/smart-views/other", json=sv).status_code == 400
    client.delete("/api/smart-views/sv-2")
    assert len(client.get("/api/smart-views").json()) == 1

    client.put("/api/email-groups/eg-2", json={"id": "eg-2", "name": "G", "members": []})
    assert len(client.get("/api/email-groups").json()) == 2

    assert client.get("/api/settings/nothing").json() is None
    client.put("/api/settings/attachTextLimit", json={"key": "attachTextLimit", "kb": 50})
    assert client.get("/api/settings/attachTextLimit").json()["kb"] == 50
    assert client.put("/api/settings/h", json={"key": "h", "handle": {}}).status_code == 400

    c = {"email": "b@corp.com", "name": "B", "projects": ["X"], "jobScope": "civil"}
    assert client.put("/api/address-book/b@corp.com", json=c).json() == c
    assert client.get("/api/address-book/b@corp.com").json()["jobScope"] == "civil"
    client.delete("/api/address-book/b@corp.com")
    assert client.get("/api/address-book/b@corp.com").json() is None


def test_maintenance(client, loaded):
    garbled = "yesterday’s".encode("utf-8").decode("latin-1")
    loaded.con.execute("UPDATE bodies SET text = ? WHERE id = 'r1@x'", (garbled,))
    loaded.con.execute("UPDATE emails SET subject = ? WHERE id = 'r1@x'", (garbled,))
    loaded.con.execute("UPDATE bodies SET text = 'a\r\n\r\n \r\nb' WHERE id = 'sys@x'")
    assert client.post("/api/maintenance/fix-mojibake").json()["fixed"] == 2
    assert loaded.get_body("r1@x") == "yesterday’s"
    assert loaded.get_email("r1@x")["subject"] == "yesterday’s"
    assert client.post("/api/maintenance/fix-mojibake").json()["fixed"] == 0
    assert client.post("/api/maintenance/normalize-linebreaks").json()["fixed"] >= 1
    assert loaded.get_body("sys@x") == "a\nb"


def test_export_streams_v3(client):
    r = client.get("/api/export")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    doc = json.loads(r.content)
    assert doc["schemaVersion"] == 3 and len(doc["emails"]) == 5


def test_import_backup_upload_into_empty(tmp_path):
    from email_tracker.store import EmailStore
    s = EmailStore(tmp_path / "e.db")
    with TestClient(create_app(Config(db_path=s.path), s), base_url="http://127.0.0.1") as c:
        r = c.post("/api/import-backup", content=backup_text(), headers=JSON).json()
        assert r["error"] is None and r["added"]["emails"] == 6
    s.close()


def test_rejects_foreign_origin_host_and_form_posts(client):
    r = client.post("/api/emails/discard-automated", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    r = client.put("/api/settings/k", content="key=k", headers={"Content-Type": "text/plain"})
    assert r.status_code == 415
    r = client.get("/api/emails", headers={"Host": "evil.example"})
    assert r.status_code == 400


# ── Phase 2: ingest, originals, maintenance ──────────────────────────────────

RFC822 = {"Content-Type": "message/rfc822"}


@pytest.fixture
def v2(tmp_path):
    from email_tracker.store import EmailStore
    s = EmailStore(tmp_path / "e.db", my_addresses=["me@work.example"])
    cfg = Config(db_path=s.path, my_addresses=["me@work.example"])
    cfg.thunderbird_profile = tmp_path / "prof"
    with TestClient(create_app(cfg, s), base_url="http://127.0.0.1") as c:
        c.store = s
        yield c
    s.close()


def test_upload_eml_then_finish(v2):
    from tests.mail import eml, multipart
    r = v2.post("/api/ingest/eml", params={"name": "a.eml"}, content=multipart(), headers=RFC822).json()
    assert r["status"] == "added" and r["id"] == "mp@x"
    r = v2.post("/api/ingest/eml", params={"name": "a.eml"}, content=multipart(), headers=RFC822).json()
    assert r["status"] == "existing"
    # I replied to Zoë, and she wrote back: the thread is waiting on me
    v2.post("/api/ingest/eml", content=eml(mid="me@x", irt="mp@x", frm="me@work.example", to="zoe@corp.com",
                                           date="Tue, 03 Mar 2026 09:00:00 +0000"), headers=RFC822)
    v2.post("/api/ingest/eml", content=eml(mid="r@x", irt="me@x", frm="zoe@corp.com",
                                           date="Wed, 04 Mar 2026 09:00:00 +0000"), headers=RFC822)
    assert v2.store.meta("derive_pending") == "1"
    v2.post("/api/ingest/finish")
    assert v2.store.meta("derive_pending") == "0"
    by = {e["id"]: e for e in v2.get("/api/emails").json()}
    assert by["r@x"]["threadId"] == "mp@x"
    assert by["r@x"]["needsMyReply"] is True
    assert not by["mp@x"].get("needsMyReply")


def test_upload_rejects_plain_text_type(v2):
    from tests.mail import eml
    assert v2.post("/api/ingest/eml", content=eml(), headers={"Content-Type": "text/plain"}).status_code == 415


def test_original_and_reparse(v2):
    from tests.mail import multipart
    v2.post("/api/ingest/eml", params={"name": "plan.eml"}, content=multipart(), headers=RFC822)
    r = v2.get(f"/api/emails/{u('mp@x')}/eml")
    assert r.status_code == 200 and r.content == multipart()
    assert "plan.eml" in r.headers["content-disposition"]
    rp = v2.post(f"/api/emails/{u('mp@x')}/reparse").json()
    assert "On Mon, Bob wrote:" in rp["rawTextBody"] and rp["attachmentsAdded"] == 0


def test_original_missing_is_404(client):
    # v1-imported emails have no archived original until their .eml is re-ingested
    assert client.get(f"/api/emails/{u('root@x')}/eml").status_code == 404
    assert client.post(f"/api/emails/{u('root@x')}/reparse").status_code == 404


def test_thunderbird_job(v2, tmp_path):
    from tests.mail import eml, mbox
    acct = tmp_path / "prof" / "ImapMail" / "acct"
    acct.mkdir(parents=True)
    (acct / "INBOX").write_bytes(mbox((eml(mid="tb1@x"), 0), (eml(mid="tb2@x"), 0)))
    (acct / "INBOX.msf").write_bytes(b"")
    assert v2.get("/api/ingest/thunderbird").json()["profile"].endswith("prof")
    job = v2.post("/api/ingest/thunderbird").json()
    assert job["status"] in ("running", "done")
    import time
    for _ in range(100):
        job = v2.get("/api/ingest/job/thunderbird").json()
        if job["status"] != "running":
            break
        time.sleep(0.05)
    assert job["status"] == "done" and job["result"]["added"] == 2


def test_maintenance_reruns(client, loaded):
    loaded.put_body("r1@x", "Keep this\nOn Tue, Bob wrote:\nold")
    client.put("/api/settings/customSignaturePatterns",
               json={"key": "customSignaturePatterns", "patterns": ["^Cheers"]})
    loaded.put_body("r2@x", "Thanks\nCheers\nZed")
    assert client.post("/api/maintenance/rerun-truncation").json()["fixed"] == 1
    assert loaded.get_body("r1@x") == "Keep this"
    assert client.post("/api/maintenance/rerun-signatures").json()["fixed"] == 1
    assert loaded.get_body("r2@x") == "Thanks"
    client.put("/api/settings/customAutomationPatterns",
               json={"key": "customAutomationPatterns", "senders": ["^a@corp"], "subjects": [], "body": []})
    n = client.post("/api/maintenance/rerun-detection").json()["fixed"]
    assert n >= 1 and loaded.get_email("root@x")["isSystemEmail"] is True
