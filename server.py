#!/usr/bin/env python3
"""
server.py — Local HTTP server for email-tracker with multi-project support.

Each project is served on its own port.  Because browsers scope IndexedDB by
origin (scheme + host + port), each port is a completely separate data silo —
no changes to the browser app are needed.

Usage:
    python server.py                      # default project on port 8000
    python server.py --project acme       # acme project (auto-assigns port)
    python server.py --project acme --port 8002   # explicit port
    python server.py --list               # list all configured projects
    python server.py --add acme           # register a new project and exit

Project registry (projects.json, auto-created next to this script):
    {
      "default": 8000,
      "acme":    8001
    }

Each project's JSON-download folder lives at:
    json-downloads/<project-name>/

The root json-downloads/ folder is NOT scanned directly — every project,
including "default", uses its own named subfolder.  This prevents the default
project from accidentally picking up files that belong to another project when
reindex_pw.py scans recursively.
"""

import argparse
import json
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

PROJECTS_FILE = Path(__file__).parent / "projects.json"
DEFAULT_PORT   = 8000


# ── Project registry ──────────────────────────────────────────────────────────

def load_projects() -> dict:
    """Load projects.json; create it with the default entry if missing."""
    if PROJECTS_FILE.exists():
        try:
            return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    projects = {"default": DEFAULT_PORT}
    _save_projects(projects)
    return projects


def _save_projects(projects: dict) -> None:
    PROJECTS_FILE.write_text(
        json.dumps(dict(sorted(projects.items())), indent=2) + "\n",
        encoding="utf-8",
    )


def next_free_port(projects: dict) -> int:
    """Return the lowest port >= DEFAULT_PORT not already used."""
    used = set(projects.values())
    port = DEFAULT_PORT
    while port in used:
        port += 1
    return port


# ── HTTP handler ──────────────────────────────────────────────────────────────

class AppHandler(SimpleHTTPRequestHandler):
    """Serve the app directory with headers required for SharedArrayBuffer."""

    def end_headers(self):
        # COOP + COEP are required for SharedArrayBuffer (used by SQLite WASM).
        # They also satisfy the constraint noted in CLAUDE.md: GitHub Pages
        # cannot serve these headers, but a local server can.
        self.send_header("Cross-Origin-Opener-Policy",   "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter output
        print(f"  {self.address_string()} — {fmt % args}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="email-tracker local server (multi-project)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project", default="default",
        help="Project name to serve (default: default)",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="Override port (otherwise taken from projects.json)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List all configured projects and exit",
    )
    parser.add_argument(
        "--add", metavar="NAME",
        help="Register a new project (assigns next free port) and exit",
    )
    args = parser.parse_args()

    projects = load_projects()

    # ── --list ──────────────────────────────────────────────────────────────
    if args.list:
        print("Configured projects:")
        for name, port in sorted(projects.items()):
            marker = "  ← default" if name == "default" else ""
            folder = f"json-downloads/{name}/"
            print(f"  {name:20s}  port {port:5d}  folder {folder}{marker}")
        return

    # ── --add ───────────────────────────────────────────────────────────────
    if args.add:
        name = args.add.strip()
        if not name:
            print("Error: project name cannot be empty.", file=sys.stderr)
            sys.exit(1)
        if name in projects:
            print(f"Project '{name}' already registered on port {projects[name]}.")
        else:
            port = args.port or next_free_port(projects)
            projects[name] = port
            _save_projects(projects)
            folder = Path(__file__).parent / "json-downloads" / name
            folder.mkdir(parents=True, exist_ok=True)
            print(f"Added project '{name}' → port {port}")
            print(f"  Folder created: json-downloads/{name}/")
        return

    # ── serve ────────────────────────────────────────────────────────────────
    project = args.project

    if args.port:
        port = args.port
        if project not in projects:
            projects[project] = port
            _save_projects(projects)
    elif project in projects:
        port = projects[project]
    else:
        # Auto-register new project
        port = next_free_port(projects)
        projects[project] = port
        _save_projects(projects)
        folder = Path(__file__).parent / "json-downloads" / project
        folder.mkdir(parents=True, exist_ok=True)
        print(f"New project '{project}' registered → port {port}")
        print(f"  Folder created: json-downloads/{project}/")

    # Serve from the directory that contains this script (the app root)
    os.chdir(Path(__file__).parent)

    print(f"Project : {project}")
    print(f"Port    : {port}")
    print(f"URL     : http://localhost:{port}/")
    print(f"Folder  : json-downloads/{project}/  (used by reindex_pw.py)")
    print()
    print("Press Ctrl-C to stop.\n")

    server = HTTPServer(("127.0.0.1", port), AppHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
