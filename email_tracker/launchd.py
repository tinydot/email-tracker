"""macOS LaunchAgents for the v2 server and its nightly backup.

Both run ``uv --directory <repo> run …`` so they use the repo's own
environment. Point them at a checkout that stays put (a dedicated worktree,
as bank-consolidator does), not a session worktree that may be cleaned up.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from xml.sax.saxutils import escape

SERVER_LABEL = "com.email-tracker.server"


def _plist(label: str, args: list[str], log: Path, extra: str) -> str:
    items = "\n".join(f"        <string>{escape(a)}</string>" for a in args)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{items}
    </array>
{extra}    <key>StandardOutPath</key>
    <string>{escape(str(log))}</string>
    <key>StandardErrorPath</key>
    <string>{escape(str(log))}</string>
</dict>
</plist>
"""


def server_plist(uv: str, repo: Path, log: Path) -> str:
    """Start at login and restart if it exits (KeepAlive), like the bank server."""
    args = [uv, "--directory", str(repo), "run", "--extra", "server", "python", "-m", "email_tracker", "serve"]
    extra = ("    <key>RunAtLoad</key>\n    <true/>\n"
             "    <key>KeepAlive</key>\n    <true/>\n"
             "    <key>ThrottleInterval</key>\n    <integer>10</integer>\n")
    return _plist(SERVER_LABEL, args, log, extra)


def install(label: str, plist: str) -> Path:
    """Write the plist to ~/Library/LaunchAgents and (re)load it."""
    dest = Path(f"~/Library/LaunchAgents/{label}.plist").expanduser()
    dest.write_text(plist)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(dest)], check=True)
    return dest
