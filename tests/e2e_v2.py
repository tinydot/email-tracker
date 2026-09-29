"""End-to-end: the real app, in the installed Google Chrome, against the v2 server.

    uv run --extra server --with playwright python tests/e2e_v2.py

Uses a throwaway database built from tests/fixtures.py (never your live one)
and the system Chrome (no browser download). Covers: v1 mode untouched off the
server, the list and detail panel loading through the API, a tag and a body
edit persisting across a reload, body search, and smart view filtering.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from email_tracker.backup_json import apply_backup  # noqa: E402
from email_tracker.store import EmailStore  # noqa: E402
from tests.fixtures import backup_text  # noqa: E402

READY = "() => typeof allEmails !== 'undefined' && document.getElementById('h-total').textContent !== '0'"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="email-v2-e2e-"))
    db = tmp / "email.db"
    store = EmailStore(db)
    apply_backup(store, [backup_text()])
    store.close()

    port = free_port()
    cfg = tmp / "config.json"
    cfg.write_text(f'{{"port": {port}}}')
    env = {**os.environ, "EMAIL_TRACKER_CONFIG": str(cfg), "EMAIL_TRACKER_DB": str(db)}
    server = subprocess.Popen([sys.executable, "-m", "email_tracker", "serve"], cwd=ROOT, env=env)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=True)

            # 1. v1 mode (file://): no flag, IndexedDB as before.
            page = browser.new_context().new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto((ROOT / "index.html").as_uri())
            page.wait_for_function("() => typeof db !== 'undefined' && db !== null")
            check("file:// runs in v1 mode", page.evaluate("V2_SERVER") is False)
            check("v1 shows the .eml import", page.evaluate(
                "document.querySelector('.nav-item[onclick=\"showImport()\"]').offsetParent !== null"))
            check("v1 has no page errors", not errors, "; ".join(errors))

            # 2. v2 mode: the server's data, v1-only controls hidden.
            ctx = browser.new_context()
            page = ctx.new_page()
            errors.clear()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/")
            page.wait_for_function(READY)
            check("served page runs in v2 mode", page.evaluate("V2_SERVER") is True)
            check("all fixture emails listed", page.evaluate("allEmails.length") == 6)  # "gone" is only tombstoned after its own import
            check(".eml import hidden in v2", page.evaluate(
                "document.querySelector('.nav-item[onclick=\"showImport()\"]').offsetParent === null"))

            # 3. Open an email, tag it, edit its body; reload; both persisted.
            page.evaluate("switchView('all')")
            page.click("#email-list .email-row[data-id='root@x']")
            page.wait_for_function("() => document.getElementById('det-body-text').textContent.includes('Hello')")
            check("detail body loaded from the server",
                  "Hello {world}" in page.inner_text("#det-body-text"))
            page.evaluate("addTag('root@x', 'e2e')")
            page.evaluate("""async () => { editBodyText();
                document.getElementById('body-edit-textarea').value = 'rewritten wombat';
                await saveBodyEdit(); }""")
            page.reload()
            page.wait_for_function(READY)
            check("tag persisted", "e2e" in page.evaluate("emailIdIndex.get('root@x').tags"))
            check("status persisted as read", page.evaluate("emailIdIndex.get('root@x').status") == "read")
            check("body edit persisted", page.evaluate("apiGetBody('root@x')") == "rewritten wombat")

            # 4. Body search goes through the server.
            page.fill("#search-input", "wombat")
            page.dispatch_event("#search-input", "input")
            page.wait_for_function("() => searchTerm === 'wombat'")
            check("body search finds the edited email",
                  page.evaluate("filteredEmails.map(e => e.id)") == ["root@x"])
            page.fill("#search-input", "")
            page.dispatch_event("#search-input", "input")
            page.wait_for_function("() => searchTerm === ''")

            # 5. The fixture smart view filters (fromDomain = corp.com, automated excluded).
            page.evaluate("switchView('sv-sv-1')")
            ids = sorted(page.evaluate("filteredEmails.map(e => e.id)"))
            check("smart view filters", ids == ["gone@x", "orphan@x", "r2@x", "root@x"], str(ids))
            check("v2 has no page errors", not errors, "; ".join(errors))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
