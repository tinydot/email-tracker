import pytest

from email_tracker.backup_json import apply_backup
from email_tracker.store import EmailStore
from tests.fixtures import backup_text


@pytest.fixture
def store(tmp_path):
    s = EmailStore(tmp_path / "email.db")
    yield s
    s.close()


@pytest.fixture
def loaded(store):
    # seenIds are flushed after emails, so tombstone "gone" first, as a live DB would have it
    store.con.execute("INSERT INTO seen_ids(id) VALUES ('gone@x')")
    res = apply_backup(store, [backup_text()])
    assert res.error is None
    return store
