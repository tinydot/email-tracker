"""Long-running server jobs (a Thunderbird scan can take minutes), run on a
background thread with progress the page polls. One job per name at a time."""
from __future__ import annotations

import threading
import time
import traceback
from collections.abc import Callable


class JobRunner:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}

    def state(self, name: str) -> dict:
        with self._lock:
            return dict(self._jobs.get(name) or {"name": name, "status": "idle"})

    def start(self, name: str, fn: Callable[[Callable[..., None]], dict]) -> dict:
        """Run ``fn(report)`` in the background; ``report(**progress)`` updates
        the job's progress. Starting a job that is already running returns it."""
        with self._lock:
            cur = self._jobs.get(name)
            if cur and cur["status"] == "running":
                return dict(cur)
            job = {"name": name, "status": "running", "startedAt": time.time(),
                   "progress": {}, "result": None, "error": None}
            self._jobs[name] = job

        def report(**progress) -> None:
            with self._lock:
                job["progress"] = progress

        def run() -> None:
            try:
                result = fn(report)
                with self._lock:
                    job.update(status="done", result=result, finishedAt=time.time())
            except Exception as e:  # noqa: BLE001 — surfaced to the page
                traceback.print_exc()
                with self._lock:
                    job.update(status="failed", error=f"{type(e).__name__}: {e}", finishedAt=time.time())

        threading.Thread(target=run, name=f"job-{name}", daemon=True).start()
        return self.state(name)

    def wait(self, name: str, timeout: float = 60) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            st = self.state(name)
            if st["status"] != "running":
                return st
            time.sleep(0.05)
        return self.state(name)
