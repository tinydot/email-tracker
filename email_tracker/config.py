"""Server configuration. Lives outside the repo, which is public and whose
corpus is work email.

``~/.config/email-tracker/config.json`` (or ``$EMAIL_TRACKER_CONFIG``)::

    {
      "db_path": "~/.local/share/email-tracker/email.db",
      "backup_dir": "~/.local/share/email-tracker/backups",
      "port": 8767,
      "allowed_hosts": ["my-mac.tailnet-name.ts.net"],
      "my_addresses": ["me@work.example", "me@alias.example"]
    }

Every key is optional. ``$EMAIL_TRACKER_DB`` overrides ``db_path``.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path("~/.config/email-tracker/config.json")
DEFAULT_DB = Path("~/.local/share/email-tracker/email.db")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _expand(p: str | Path) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p)))).resolve()


@dataclass
class Config:
    db_path: Path = field(default_factory=lambda: _expand(DEFAULT_DB))
    backup_dir: Path | None = None  # None: <db_path's folder>/backups
    port: int = 8767  # bank-consolidator runs on 8765/8766
    # Extra Host names to accept, e.g. the Tailscale Serve name later. The
    # server always binds loopback only; this list just stops DNS rebinding.
    allowed_hosts: list[str] = field(default_factory=list)
    # The owner's addresses — needs_my_reply (Phase 2) keys on these. Only in
    # the config file: the repo is public.
    my_addresses: list[str] = field(default_factory=list)
    static_root: Path = REPO_ROOT
    config_path: Path | None = None

    @property
    def hosts(self) -> list[str]:
        return [*LOOPBACK_HOSTS, *self.allowed_hosts]


def load() -> Config:
    path = _expand(os.environ.get("EMAIL_TRACKER_CONFIG", CONFIG_PATH))
    raw = json.loads(path.read_text()) if path.exists() else {}
    cfg = Config()
    if raw.get("db_path"):
        cfg.db_path = _expand(raw["db_path"])
    if raw.get("backup_dir"):
        cfg.backup_dir = _expand(raw["backup_dir"])
    if raw.get("port"):
        cfg.port = int(raw["port"])
    cfg.allowed_hosts = [str(h) for h in raw.get("allowed_hosts", [])]
    if raw.get("my_addresses"):
        cfg.my_addresses = [str(a).lower() for a in raw["my_addresses"]]
    cfg.config_path = path
    if os.environ.get("EMAIL_TRACKER_DB"):
        cfg.db_path = _expand(os.environ["EMAIL_TRACKER_DB"])
    return cfg
