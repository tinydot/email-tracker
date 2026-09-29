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
