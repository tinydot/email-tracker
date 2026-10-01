"""The v2 server: owns email.db and serves the unchanged browser UI.

``GET /`` serves index.html with ``window.EMAIL_V2_SERVER = true`` injected, so
the page's data layer (js/api.js) calls this API instead of IndexedDB. The file
itself is untouched, so GitHub Pages keeps serving v1.

The API is purpose-built: one route per thing the UI does, each named after the
v1 call sites it replaces (see CLAUDE.md, "v2 mode"). Records travel in v1's
camelCase shape, so the rule engine, rendering and threading code run as before.

Bind loopback only. Hostile pages in the same browser are the threat model: the
Host allow-list defeats DNS rebinding, non-GET requests carrying a foreign
Origin are refused, and every write needs a JSON content type, which a
cross-origin form can't send without a CORS preflight this server never approves.
"""
from __future__ import annotations

import queue
import re
import threading
from collections.abc import Iterator
from datetime import date

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import maintenance
from .backup_json import apply_backup, stream_backup_json
from .config import Config
from .ingest import Ingestor, reparse
from .jobs import JobRunner
from .store import DOC_TABLES, EmailStore, NotFound

V2_FLAG = "<script>window.EMAIL_V2_SERVER = true;</script>\n"
DOC_ROUTES = {"smart-views": "smartViews", "email-groups": "emailGroups"}


def _inject_flag(html: str) -> str:
    """Put the v2 flag first thing in <head>, ahead of every app script."""
    m = re.search(r"<head[^>]*>", html, re.IGNORECASE)
    if not m:
        raise ValueError("index.html has no <head>; cannot inject the v2 flag")
    return html[:m.end()] + "\n" + V2_FLAG + html[m.end():]


def _stream_export(store: EmailStore) -> Iterator[bytes]:
    """Run the export on a worker thread, handing ~1MB pieces to the response.
    The queue is bounded, so a slow download pauses the export rather than
    buffering the database in memory."""
    q: queue.Queue = queue.Queue(maxsize=8)
    DONE = object()

    def produce() -> None:
        buf: list[str] = []
        size = 0

        def write(s: str) -> None:
            nonlocal size
            buf.append(s)
            size += len(s)
            if size >= 1 << 20:
                q.put("".join(buf).encode())
                buf.clear()
                size = 0
        try:
            stream_backup_json(store, write)
            if buf:
                q.put("".join(buf).encode())
        except BaseException as e:  # surfaced to the consumer
            q.put(e)
        finally:
            q.put(DONE)

    threading.Thread(target=produce, daemon=True).start()
    while True:
        item = q.get()
        if item is DONE:
            return
        if isinstance(item, BaseException):
            raise item
        yield item


def create_app(cfg: Config, store: EmailStore | None = None) -> FastAPI:
    store = store or EmailStore(cfg.db_path, cfg.my_addresses)
    store.rederive_if_pending()  # an ingest interrupted last time
    ingestor = Ingestor(store, cfg.archive_dir)
    jobs = JobRunner()
    app = FastAPI(title="email-tracker", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=cfg.hosts)
    app.state.store = store

    @app.middleware("http")
    async def guard_writes(request: Request, call_next):
        if request.method not in ("GET", "HEAD"):
            origin = request.headers.get("origin")
            if origin:
                host = re.sub(r"^https?://", "", origin).split(":")[0]
                if host not in cfg.hosts:
                    return JSONResponse({"error": "cross-origin write refused"}, status_code=403)
            ctype = request.headers.get("content-type", "")
            body_len = request.headers.get("content-length")
            has_body = (body_len not in (None, "0")) or "transfer-encoding" in request.headers
            # Neither is a CORS "simple" type, so a cross-site page can't send
            # one without a preflight, which this server never approves.
            if has_body and not (ctype.startswith("application/json")
                                 or ctype.startswith("message/rfc822")):
                return JSONResponse({"error": "writes must be application/json"}, status_code=415)
        return await call_next(request)

    index_html = _inject_flag((cfg.static_root / "index.html").read_text(encoding="utf-8"))

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse(index_html, headers={"Cache-Control": "no-store"})

    app.mount("/js", StaticFiles(directory=cfg.static_root / "js"), name="js")
    app.mount("/css", StaticFiles(directory=cfg.static_root / "css"), name="css")

    def nf(e: NotFound) -> HTTPException:
        return HTTPException(404, f"not found: {e.args[0]}")

    # ── emails ──────────────────────────────────────────────────────────────

    @app.get("/api/emails")
    def list_emails() -> list[dict]:            # data-load.js loadEmailList, init.js
        return store.list_emails()

    @app.patch("/api/emails/{email_id:path}/fields")
    def patch_email(email_id: str, fields: dict = Body(...)) -> dict:   # actions.js, render.js mark-read
        try:
            return store.patch_email(email_id, fields)
        except NotFound as e:
            raise nf(e)

    @app.post("/api/emails/patch-many")
    def patch_many(items: list[dict] = Body(...)) -> dict:   # data-load.js backfillSystemEmailFlag
        n = 0
        for it in items:
            try:
                store.patch_email(it["id"], it.get("fields") or {})
                n += 1
            except (NotFound, KeyError):
                pass
        return {"updated": n}

    @app.delete("/api/emails/{email_id:path}/record")
    def delete_email(email_id: str) -> dict:    # actions.js deleteEmail
        try:
            store.delete_email(email_id)
        except NotFound as e:
            raise nf(e)
        return {"ok": True}

    @app.post("/api/emails/discard-automated")
    def discard_automated() -> dict:            # export.js discardAutomatedEmails
        ingestor.purge_automated_originals()    # their originals go with them
        ids = store.discard_automated()
        return {"discarded": ids}

    # ── bodies ──────────────────────────────────────────────────────────────

    @app.get("/api/emails/{email_id:path}/body")
    def get_body(email_id: str) -> dict:        # render.js openDetail
        return {"id": email_id, "text": store.get_body(email_id)}

    @app.put("/api/emails/{email_id:path}/body")
    def put_body(email_id: str, payload: dict = Body(...)) -> dict:   # render.js truncation / edit
        text = payload.get("text")
        if not isinstance(text, str):
            raise HTTPException(400, "body needs a string 'text'")
        try:
            store.put_body(email_id, text)
        except NotFound as e:
            raise nf(e)
        return {"ok": True}

    @app.post("/api/bodies")
    def bodies(payload: dict = Body(...)) -> list[dict]:   # data-load.js backfill, sidebar.js links
        ids = payload.get("ids") or []
        return [{"id": i, "text": t} for i, t in store.bodies_for(ids)]

    @app.get("/api/search/bodies")
    def search_bodies(q: str = "") -> list[str]:   # routing.js scanBodiesFor
        return store.search_body_ids(q)

    # ── attachments ─────────────────────────────────────────────────────────

    @app.get("/api/attachments")
    def attachments() -> list[dict]:            # data-load.js, sidebar.js (no extracted text)
        return store.list_attachments(light=True)

    @app.get("/api/emails/{email_id:path}/attachments")
    def email_attachments(email_id: str) -> list[dict]:   # render.js attachment panel
        return store.list_attachments(email_id)

    @app.post("/api/attachments/{att_id:path}/toggle-blacklist")
    def toggle_blacklist(att_id: str) -> dict:   # render.js toggleAttachmentBlacklist
        try:
            return store.toggle_attachment_blacklisted(att_id)
        except NotFound as e:
            raise nf(e)

    # ── smart views, email groups ───────────────────────────────────────────

    for route, name in DOC_ROUTES.items():
        def _make(name: str = name) -> None:
            key = DOC_TABLES[name][1]

            @app.get(f"/api/{route}", name=f"list_{name}")
            def list_docs() -> list[dict]:
                return store.list_docs(name)

            @app.put(f"/api/{route}/{{doc_id:path}}", name=f"put_{name}")
            def put_doc(doc_id: str, record: dict = Body(...)) -> dict:
                if record.get(key) != doc_id:
                    raise HTTPException(400, f"record {key} does not match the URL")
                return store.put_doc(name, record)

            @app.delete(f"/api/{route}/{{doc_id:path}}", name=f"delete_{name}")
            def delete_doc(doc_id: str) -> dict:
                store.delete_doc(name, doc_id)
                return {"ok": True}
        _make()

    # ── settings ────────────────────────────────────────────────────────────

    @app.get("/api/settings/{key}")
    def get_setting(key: str) -> dict | None:
        return store.get_doc("settings", key)

    @app.put("/api/settings/{key}")
    def put_setting(key: str, record: dict = Body(...)) -> dict:
        if record.get("key") != key:
            raise HTTPException(400, "record key does not match the URL")
        try:
            return store.put_doc("settings", record)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/settings/{key}")
    def delete_setting(key: str) -> dict:
        store.delete_doc("settings", key)
        return {"ok": True}

    # ── address book ────────────────────────────────────────────────────────

    @app.get("/api/address-book")
    def contacts() -> list[dict]:
        return store.list_contacts()

    @app.get("/api/address-book/{email}")
    def contact(email: str) -> dict | None:
        return store.get_contact(email)

    @app.put("/api/address-book/{email}")
    def put_contact(email: str, record: dict = Body(...)) -> dict:
        if record.get("email") != email:
            raise HTTPException(400, "record email does not match the URL")
        return store.put_contact(record)

    @app.delete("/api/address-book/{email}")
    def delete_contact(email: str) -> dict:
        store.delete_contact(email)
        return {"ok": True}

    # ── maintenance ─────────────────────────────────────────────────────────

    @app.post("/api/maintenance/fix-mojibake")
    def fix_mojibake() -> dict:                 # settings.js fixMojibakeEmails
        return {"fixed": store.fix_mojibake()}

    @app.post("/api/maintenance/normalize-linebreaks")
    def normalize_linebreaks() -> dict:         # settings.js normalizeLineBreaks
        return {"fixed": store.normalize_linebreaks()}

    # ── backup JSON (v1's Export / Import JSON) ─────────────────────────────

    @app.get("/api/export")
    def export() -> StreamingResponse:
        name = f"email-tracker-{date.today().isoformat()}.json"
        return StreamingResponse(_stream_export(store), media_type="application/json",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"',
                                          "Cache-Control": "no-store"})

    @app.post("/api/import-backup")
    async def import_backup(request: Request) -> dict:
        # Bridge the async request body to the blocking importer through a
        # bounded queue, so the upload is applied as it arrives.
        q: queue.Queue = queue.Queue(maxsize=16)
        END = object()

        def chunks() -> Iterator[str]:
            import codecs
            dec = codecs.getincrementaldecoder("utf-8")()
            while True:
                item = q.get()
                if item is END:
                    tail = dec.decode(b"", final=True)
                    if tail:
                        yield tail
                    return
                yield dec.decode(item)

        import asyncio
        loop = asyncio.get_running_loop()
        job = loop.run_in_executor(None, lambda: apply_backup(store, chunks()))
        try:
            async for piece in request.stream():
                if piece:
                    await run_in_threadpool(q.put, piece)
        finally:
            await run_in_threadpool(q.put, END)
        res = await job
        return res.as_dict()

    # ── ingest (.eml upload, Thunderbird) ──────────────────────────────────

    @app.post("/api/ingest/eml")
    async def ingest_eml(request: Request, name: str = "message.eml") -> dict:
        """One raw message per request (the page uploads files one by one).
        Derived state is left pending for /api/ingest/finish."""
        raw = await request.body()
        if not raw:
            raise HTTPException(400, "empty message")

        def work() -> dict:
            b = ingestor.batch()
            status = b.add(raw, name)
            b._commit()  # no rederive per file; /finish does it once
            return {"status": status, "error": (b.result.errors or [None])[0],
                    "id": (b.result.added_ids or [None])[0]}
        return await run_in_threadpool(work)

    @app.post("/api/ingest/finish")
    def ingest_finish() -> dict:
        store.rederive_if_pending()
        return {"ok": True}

    @app.get("/api/ingest/thunderbird")
    def thunderbird_info() -> dict:
        from .mbox import default_profile
        p = cfg.thunderbird_profile or default_profile()
        return {"profile": str(p) if p else None, "job": jobs.state("thunderbird")}

    @app.post("/api/ingest/thunderbird")
    def thunderbird_scan() -> dict:
        from .mbox import default_profile, scan_profile
        p = cfg.thunderbird_profile or default_profile()
        if not p or not p.is_dir():
            raise HTTPException(404, "no Thunderbird profile found; set thunderbird_profile in the server config")

        def run(report) -> dict:
            res = scan_profile(ingestor, p, lambda folder, done, total, r: report(
                folder=folder, percent=round(100 * done / total), messages=r.messages, added=r.added))
            return res.as_dict()
        return jobs.start("thunderbird", run)

    @app.get("/api/ingest/job/{name}")
    def job_state(name: str) -> dict:
        return jobs.state(name)

    # ── archived originals ─────────────────────────────────────────────────

    @app.get("/api/emails/{email_id:path}/eml")
    def email_original(email_id: str) -> FileResponse:   # import.js openOriginalEml
        try:
            rec = store.get_email(email_id)
        except NotFound as e:
            raise nf(e)
        path = ingestor.archived_path(rec.get("emlArchivePath"))
        if path is None:
            raise HTTPException(404, "no archived original for this email — re-ingest its .eml to add one")
        return FileResponse(path, media_type="message/rfc822", filename=path.name)

    @app.post("/api/emails/{email_id:path}/reparse")
    def email_reparse(email_id: str) -> dict:          # import.js reimportEmlBody
        try:
            return reparse(ingestor, email_id)
        except NotFound as e:
            raise nf(e)
        except FileNotFoundError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/maintenance/purge-automated-originals")
    def purge_automated_originals() -> dict:
        return ingestor.purge_automated_originals()

    @app.post("/api/maintenance/rerun-truncation")
    def rerun_truncation() -> dict:
        return {"fixed": maintenance.rerun_truncation(store)}

    @app.post("/api/maintenance/rerun-signatures")
    def rerun_signatures() -> dict:
        return {"fixed": maintenance.rerun_signatures(store)}

    @app.post("/api/maintenance/rerun-detection")
    def rerun_detection() -> dict:
        fixed = maintenance.rerun_detection(store)
        if fixed:
            ingestor.purge_automated_originals()  # newly flagged mail: originals aren't kept
        return {"fixed": fixed}

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "counts": store.counts()}

    return app
