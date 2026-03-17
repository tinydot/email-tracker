#!/usr/bin/env python3
"""
reindex_pw.py — Playwright-based JSON re-import for email-tracker.

Scans json-downloads/<project>/ for .json export files and imports them
into the running email-tracker browser app via the UI file-input element.

Usage:
    python reindex_pw.py                       # re-import default project
    python reindex_pw.py --project acme        # re-import acme project
    python reindex_pw.py --project acme --url http://localhost:8001/
    python reindex_pw.py --headless            # no browser window

Key design decision — folder layout
------------------------------------
Each project's data lives under its own named subfolder:

    json-downloads/
        default/          ← default project only
            export-2026-03-17.json
        acme/             ← acme project only
            export-2026-03-10.json

This prevents the default project from picking up files belonging to another
project.  Previously, if "default" scanned json-downloads/ recursively it
would ingest any subfolder's exports too.

The root json-downloads/ directory is NEVER scanned directly.

Prerequisites
-------------
    pip install playwright
    python -m playwright install chromium

The email-tracker server must already be running:
    python server.py --project <name>
"""

import argparse
import json
import sys
from pathlib import Path

PROJECTS_FILE = Path(__file__).parent / "projects.json"
DEFAULT_PORT   = 8000

# ── Project registry ──────────────────────────────────────────────────────────

def load_projects() -> dict:
    if PROJECTS_FILE.exists():
        try:
            return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"default": DEFAULT_PORT}


# ── Import logic ──────────────────────────────────────────────────────────────

def import_json_file(page, json_file: Path) -> None:
    """
    Feed a single JSON export file to the email-tracker import input.

    The hidden <input type="file" id="json-import-input"> is set directly via
    Playwright's set_input_files() — this bypasses the OS file-picker dialog
    entirely so the script can run unattended.
    """
    file_input = page.locator("#json-import-input")
    file_input.set_input_files(str(json_file.resolve()))

    # Wait for the toast notification that signals completion
    toast = page.locator("#toast")
    toast.wait_for(state="visible", timeout=60_000)

    # Allow IndexedDB writes to flush before the next import
    page.wait_for_timeout(1_200)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="email-tracker Playwright reindex",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project", default="default",
        help="Project name (default: default)",
    )
    parser.add_argument(
        "--url", default=None,
        help="Override base URL, e.g. http://localhost:9000/",
    )
    parser.add_argument(
        "--folder", default=None,
        help="Override JSON-downloads folder (default: json-downloads/<project>/)",
    )
    parser.add_argument(
        "--headless", action="store_true", default=False,
        help="Run Chromium in headless mode",
    )
    args = parser.parse_args()

    project = args.project

    # ── Resolve folder ───────────────────────────────────────────────────────
    # Always use json-downloads/<project>/, never the root json-downloads/.
    # This is the fix for the folder clash: each project, including "default",
    # gets its own dedicated subfolder.
    if args.folder:
        folder = Path(args.folder)
    else:
        folder = Path(__file__).parent / "json-downloads" / project

    # ── Resolve server URL ───────────────────────────────────────────────────
    projects = load_projects()
    if args.url:
        base_url = args.url.rstrip("/")
    elif project in projects:
        base_url = f"http://localhost:{projects[project]}"
    else:
        base_url = f"http://localhost:{DEFAULT_PORT}"

    # ── Validate folder ──────────────────────────────────────────────────────
    if not folder.exists():
        print(f"Folder not found: {folder}")
        print()
        print("Create it and place JSON exports inside, e.g.:")
        print(f"    mkdir -p {folder}")
        print(f"    # then copy your .json exports into {folder}/")
        sys.exit(1)

    json_files = sorted(folder.glob("*.json"))
    if not json_files:
        print(f"No .json files found in {folder}")
        print("Export the database first:  ⬇ Export JSON  (in the app sidebar)")
        sys.exit(0)

    print(f"Project : {project}")
    print(f"Folder  : {folder}  ({len(json_files)} file(s))")
    print(f"URL     : {base_url}")
    print()

    # ── Playwright ───────────────────────────────────────────────────────────
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed.")
        print("Run:  pip install playwright && python -m playwright install chromium")
        sys.exit(1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless)
        context = browser.new_context()
        page    = context.new_page()

        print(f"Opening {base_url} …")
        try:
            page.goto(base_url, wait_until="networkidle", timeout=15_000)
        except Exception as exc:
            print(f"Could not reach {base_url}: {exc}")
            print()
            print("Make sure the server is running:")
            print(f"    python server.py --project {project}")
            browser.close()
            sys.exit(1)

        ok = errors = 0
        for json_file in json_files:
            print(f"  {json_file.name} … ", end="", flush=True)
            try:
                import_json_file(page, json_file)
                print("ok")
                ok += 1
            except Exception as exc:
                print(f"FAILED ({exc})")
                errors += 1

        browser.close()

    print()
    print(f"Done — {ok} imported, {errors} failed.")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
