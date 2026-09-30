import json

import pytest

from email_tracker.backup_json import BackupFormatError, BackupScanner, apply_backup, stream_backup_json
from email_tracker.store import EmailStore
from tests.fixtures import backup, backup_text


def scan(chunks):
    out = []
    s = BackupScanner(lambda k, v: out.append((k, v)))
    for c in chunks:
        s.feed(c)
    s.end()
    return out


@pytest.mark.parametrize("size", [1, 2, 3, 7, 64, 10**9])
def test_scanner_any_chunking(size):
    text = backup_text(indent=1)
    whole = scan([text])
    assert scan([text[i:i + size] for i in range(0, len(text), size)]) == whole
    assert ("schemaVersion", 3) in whole
    assert sum(1 for k, _ in whole if k == "emails") == len(backup()["emails"])


def test_scanner_rejects_garbage():
    with pytest.raises(BackupFormatError):
        scan(["[1,2]"])
    with pytest.raises(BackupFormatError):
        scan(['{"emails":[{"id":1}'])
    with pytest.raises(BackupFormatError):
        scan(['{"a":1} x'])


def test_import_counts_and_split(loaded):
    c = loaded.counts()
    # "gone" is tombstoned, so it and its attachment stay out
    assert c["emails"] == 5
    assert c["attachments"] == 1
    assert c["bodies"] == 4          # "orphan" had no body
    assert c["smartViews"] == 1 and c["emailGroups"] == 1 and c["addressBook"] == 1
    assert c["settings"] == 1        # the folder-handle setting is machine-local
    assert c["tags"] == 1
    # body split out and blank-line runs collapsed like applyBackupStream
    assert loaded.get_body("root@x") == 'Hello {world}\nsecond "quoted" \\ line'
    e = loaded.get_email("root@x")
    assert "textBody" not in e
    assert e["tags"] == ["action"] and e["tagExclusions"] == ["fyi"]


def test_reimport_is_noop(loaded):
    before = loaded.counts()
    res = apply_backup(loaded, [backup_text()])
    assert sum(res.added.values()) == 0
    assert res.emails_skipped == 6   # the 5 present + the tombstoned one
    assert loaded.counts() == before


def test_unknown_fields_round_trip(loaded):
    assert loaded.get_email("orphan@x")["customField"] == {"keep": [1, 2]}
    assert loaded.get_contact("a@corp.com")["jobScope"] == "MEP"


def test_export_reimports_identically(loaded, tmp_path):
    parts = []
    n = stream_backup_json(loaded, parts.append)
    assert n == 5
    doc = json.loads("".join(parts))
    assert doc["schemaVersion"] == 3
    assert {e["id"] for e in doc["emails"]} == {"root@x", "r1@x", "r2@x", "sys@x", "orphan@x"}
    root = next(e for e in doc["emails"] if e["id"] == "root@x")
    assert root["textBody"].startswith("Hello {world}")

    fresh = EmailStore(tmp_path / "fresh.db")
    res = apply_backup(fresh, ["".join(parts)])
    assert res.error is None
    by_id = lambda recs: sorted(recs, key=lambda r: r["id"])  # noqa: E731
    assert by_id(fresh.list_emails()) == by_id(loaded.list_emails())
    assert fresh.list_attachments() == loaded.list_attachments()
    assert fresh.list_contacts() == loaded.list_contacts()
    assert fresh.list_docs("smartViews") == loaded.list_docs("smartViews")
    assert fresh.counts() == loaded.counts()
    fresh.close()


def test_malformed_tail_keeps_earlier_records(store):
    text = backup_text()
    cut = text.index('"attachments"')
    res = apply_backup(store, [text[:cut] + '"attachments":[{"id":'])
    assert res.error and "restored before the error" in res.error
    assert store.counts()["emails"] == 6


def test_fts_indexes_subject_and_body(loaded):
    hits = loaded.con.execute(
        "SELECT e.id FROM emails_fts f JOIN emails e ON e.seq = f.rowid WHERE emails_fts MATCH ?",
        ("Zürich",)).fetchall()
    assert [h[0] for h in hits] == ["r2@x"]
