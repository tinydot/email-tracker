# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Email Tracker — Claude Context

## Project at a glance

A client-side web app with no build step, no npm, and no external runtime dependencies. Open `index.html` in a browser and it runs entirely in-browser using the File System Access API and IndexedDB (**v1**, the GitHub Pages version).

**Migration in progress (2026-09-29):** the same page can also be served by a local Python server that owns an SQLite `email.db` (**v2**), so other processes (the life-mcp MCP server) can read live data. See [v2 server](#v2-server-migration-in-progress) below, `HANDOVER.md` in the main checkout, and `~/Developer/life-mcp/HANDOVER.md`. v1 and its Pages URL stay untouched as the rollback until v2 meets the acceptance criteria.

```
email-tracker/
├── index.html        ← HTML structure only (~190 lines)
├── css/
│   └── styles.css    ← all styles (~1050 lines)
├── email_tracker/    ← v2 server (Python; see "v2 server" below)
├── tests/            ← pytest suite + Playwright e2e for v2
├── pyproject.toml    ← v2 package (uv)
└── js/
    ├── db.js         ← IndexedDB wrapper (openDB + db* helpers)
    ├── api.js        ← data API: one function per UI operation, IndexedDB (v1) or server (v2)
    ├── parser.js     ← EML parser (MIME, encodings, signature/quote stripping)
    ├── detection.js  ← system/automated email detection patterns
    ├── import.js     ← import pipeline, EML archiving, reimport, Thunderbird mbox import (v1)
    ├── server-import.js ← v2: upload .eml to the server, Thunderbird scan on the server
    ├── threading.js  ← msgId/emailId indexes + memoized thread root/depth caches
    ├── state.js      ← global state variables + showPanel
    ├── smart-views/  ← smart views (split into focused modules)
    │   ├── rule-engine.js ← RULE_FIELDS, evaluateRule, applySmartViewRules, lowercase caches
    │   ├── editor.js      ← smart view editor modal (grouped rules, required tags)
    │   ├── sidebar.js     ← renderSmartViewsSidebar, sv tab toggle, sv attachments + links views
    │   ├── routing.js     ← switchView, applyFilters, searchEmails, applySort
    │   └── settings.js    ← showSettings: email groups, custom patterns, maintenance
    ├── render.js     ← virtual-scrolled email list, detail modal, body edit/truncation
    ├── actions.js    ← email actions (tags, automated toggle, delete)
    ├── data-load.js  ← loadEmailList, updateHeaderStats, updateNavCounts, backfill
    ├── export.js     ← JSON export/import (streamBackupJson/applyBackupStream), clearDB, discard automated
    ├── gdrive.js     ← Google Drive backup/restore (GIS OAuth, drive.file scope)
    ├── address-book.js ← contact profiles (name, role, projects)
    ├── dashboard.js  ← email volume over time, import activity, sender domains
    ├── helpers.js    ← drag & drop, formatDate, escHtml, toast
    └── init.js       ← init(), keyboard shortcuts (j/k, Escape)
```

All JS files share a single global scope (loaded via `<script src>` tags in `index.html`), so there are no module imports. **Script load order matters** — load order is: db, api, parser, detection, import, server-import, threading, state, smart-views/{rule-engine, editor, sidebar, routing, settings}, render, actions, data-load, export, gdrive, address-book, dashboard, helpers, init. The section banners (`// ═══…`) within each file mark sub-sections.

### Companion scripts (outside the web app)

- `pst_to_eml.py` — Windows-only; uses Outlook COM to export a `.pst` archive
  to `.eml` files importable by the web app. See `pst_to_eml_README.md`.
- `imap_sync.py` — Python stdlib only; incrementally syncs an IMAP account to
  `.eml` files. See `imap_sync_README.md`.
- `fix-mojibake.js` — one-off DevTools console script to repair mis-decoded
  UTF-8 bodies in an existing IndexedDB. Paste into the console; safe to re-run.
  (A version of this also exists in-app: Settings → maintenance.)

## Data model

### Email record (stored in IndexedDB `emails` store)
```js
{
  id,             // messageId; else v1: "filename-date", v2: "sha256:<raw bytes>"
  messageId,      // RFC Message-ID header
  inReplyTo,      // RFC In-Reply-To header
  references,     // array of referenced message IDs
  subject,
  fromAddr,       // sender email
  fromName,       // sender display name
  toAddrs,        // array of recipient emails
  ccAddrs,        // array of CC emails
  date,           // ISO string
                  // NB: no textBody — bodies live in the separate `bodies` store
  status,         // 'unread' | 'read'
  isSystemEmail,  // boolean — auto-detected automated/bulk email
  manualSystemOverride, // boolean — user unmarked automated; detection won't re-flag
  hasAttachments,
  attachmentCount,
  tags,           // string[]
  tagExclusions,  // string[] — tags the user excluded (won't be re-applied)
  importedAt,     // ISO string
  fileName,       // original .eml filename
  emlArchivePath, // optional — path if EML organizing is enabled
}
```

### IndexedDB stores (`DB_VERSION = 10` in `js/db.js`)
- `emails` — email records, **metadata only** (indexes: messageId, threadId, date, fromAddr, status, isActionable, importedAt)
- `bodies` — `{ id, text }`, one record per email, keyed by email id. Split out of
  `emails` in v10 so loading the corpus into `allEmails` doesn't pull every body
  into the heap — bodies were ~90% of resident size. Accessed only through
  `getBody` / `putBody` / `deleteBody`, or streamed with `dbIterate` / `dbGetMany`.
  An email with an empty body has no record here. `onupgradeneeded` migrates
  existing inline bodies across with a cursor.
- `attachments` — attachment metadata only (indexes: `emailId`, `hash`) — attachment files are **not** extracted to disk; the archived .eml is the attachment store, and "opening" an attachment downloads the email's .eml (`downloadEmlForAttachment`)
- `tags` — global tag registry (keyPath: `name`) — note: tags are also stored inline on each email
- `msgIndex` — messageId → emailId mapping
- `smartViews` — user-defined filter views (keyPath: `id`)
- `settings` — key-value store (custom automation/quote/signature patterns, signature ranges, attach text limit, persisted EML archive folder handle `emlArchiveDirHandle`, Google Drive backup config `gdrive` = `{clientId, autoBackup, lastBackup}`, …)
- `emailGroups` — named address lists used by smart view group rules
- `seenIds` — tombstones for discarded email IDs (prevents reimport)
- `addressBook` — contact profiles (keyPath: `email`)

Legacy stores (`issues`, `insights`, `embeddings`) are deleted in `onupgradeneeded`.

## Key global state variables (`js/state.js`)
```js
allEmails        // full email array loaded from DB
filteredEmails   // currently displayed subset (result of applyFilters())
currentView      // 'all' | 'dashboard' | 'unread' | 'threads' | 'attachments' |
                 // 'automated' | 'addressbook' | 'sv-<id>'
currentSort      // 'date-desc' | 'date-asc' | 'from' | 'subject'
searchTerm       // active search string
selectedEmail    // currently open email object (same object as in allEmails)
selectedEmailIdx // index in filteredEmails for j/k navigation
smartViews       // array loaded from DB on init
svSubView        // 'emails' | 'attachments' — sub-view within a smart view
emailGroups      // email groups for smart view rules
```

## Important patterns

**Rendering flow:** `switchView(view)` → `applyFilters()` → `renderEmailList()`. The list is virtual-scrolled (`VS_ROW_HEIGHT`, `vsRenderSlice` in `js/render.js`) — only visible rows are in the DOM.

**Filtering:** `applyFilters()` rebuilds `filteredEmails` from `allEmails` in a single pass: smart-view rules or built-in view filter, system-email exclusion (all views except `automated`; smart views can opt out via `excludeAutomated`), full-text search, then sort.

**Data access goes through `js/api.js`.** UI code calls `api*` functions (`apiSaveEmail`, `apiGetBody`, `apiPutDoc`, `apiGetSetting`, …), never the `db*` helpers directly — each `api*` function runs the original db.js calls in v1 and the matching server route in v2. The exceptions are v1-only code paths (the .eml import pipeline in `import.js`, attachment text extraction in `parser.js`, `gdrive.js`, `clearDB`, the backup stream in `export.js`), which are hidden in v2.

**DB writes:** always `await apiSaveEmail(email)` — email objects in `allEmails` are mutated in-place, then saved. `selectedEmail` is the same object reference, so no separate sync is needed. In v2 only the user-editable fields travel (`_EMAIL_PATCHABLE` in api.js, `EMAIL_PATCHABLE` in store.py); everything else is set at ingest.

**Bodies are not in memory.** Never park a body on an email object in `allEmails` — that's what the `bodies` store exists to prevent. The access patterns are:
- *One email* (detail panel): `await apiGetBody(id)`. `openDetail` renders a placeholder and fills it in, keeping the result in `selectedEmailBody` for the truncation/edit controls; `_loadedBodyId` marks which email that body belongs to, and `closeDetail` clears both.
- *A known subset* (links sub-view, detection backfill): `apiForEachBody(ids, fn)` (v1: `dbGetMany` — one transaction, callback per record, nothing accumulated; v2: batched `POST /api/bodies`).
- *The whole store* (search, maintenance): `dbIterate('bodies', fn, mode)` — a cursor pass; in `'readwrite'` mode a record returned by `fn` is written back in place. `fn` must be synchronous or the transaction closes underneath it.
- *Writes*: `apiPutBody(id, text)` (an empty string deletes the record); `apiDeleteEmail` / `apiDiscardAutomated` remove bodies with their emails.

**Thunderbird import** (`handleThunderbirdFiles` in js/import.js) reads a Thunderbird profile's mbox files directly — each folder is one mbox with a sibling `.msf`. The folder comes from `<input webkitdirectory>`, *not* `showDirectoryPicker`: Chrome's File System Access blocklist refuses everything under `~/Library`, where macOS profiles live. `scanMboxOffsets` streams the file recording only separator offsets ("From " at file start or after a blank line), and each message becomes a `File` over a lazy `Blob.slice`, so `processFilesForImport` runs unchanged (dedup by Message-ID, EML archiving, attachments) without the mbox ever being read whole. Messages flagged expunged in `X-Mozilla-Status` and folders matching `MBOX_SKIP_FOLDERS` (Trash, Junk, Drafts…) are skipped. The fallback id for a message with neither Message-ID nor Date is `name-<content hash>`, so a re-scan is a no-op.

**Backups stream in both directions** — neither the export nor the restore ever holds the document whole.

*Writing:* `streamBackupJson(write)` walks each store with a cursor and serializes records one at a time; `makeBackupSink()` flushes the text into Blob chunks every ~1M chars, so it lives in browser storage rather than the JS heap. `buildBackupBlob()` wraps both and is what `exportData` and `gdriveBackupNow` call — the Drive upload builds its multipart body as a Blob around it. Emails are paired with their bodies by `dbIterateEmailsWithBodies`, a merge join over the two id-ordered stores in one transaction.

*Reading:* `applyBackupStream(stream)` takes a `ReadableStream` (`file.stream()` for JSON import, the download's `resp.body` for a Drive restore). `makeBackupScanner` is not a full JSON parser — the document is a flat object of record arrays, so it only finds record *boundaries* (tracking string/escape state so braces in a subject don't count) and hands each record's text to `JSON.parse`. Records are buffered only between stream chunks and written with `dbAddMissing` / `dbPutMany`, one transaction per batch. Because records are applied as they arrive, a file that turns out to be malformed partway through leaves the earlier records restored — the error names the count, and re-running a fixed file skips them.

**Body search:** `applyFilters()` is synchronous and bodies are not, so `searchEmails()` first runs `scanBodiesFor(term)` — one cursor pass keeping only the matching ids (v2: `GET /api/search/bodies`, the same case-insensitive substring test run in SQLite) — into `searchBodyMatches`, then filters. A generation counter discards a scan the user has typed past. After editing one body, call `updateSearchMatchForBody(id, text)` rather than rescanning.

**In-memory caches** (rebuild after `allEmails` changes):
- `rebuildMsgIdIndex()` — rebuilds `msgIdIndex` (messageId → email) and `emailIdIndex` (id → email; use this instead of `allEmails.find`). Also invalidates the thread caches.
- `buildThreadCache()` — must run *after* `rebuildMsgIdIndex()`; populates memoized thread root/depth caches and per-root reply counts (`hasReplies`, `countThreadReplies`, `getThreadRoot`, `getThreadDepth` are O(1) after this).
- `updateHeaderStats()` rebuilds both caches from the in-memory `allEmails` (it does **not** re-read emails from the DB — callers must update `allEmails` first) and refreshes header/nav counts.
- `getEmailLC(email)` caches lowercase field forms in a `_lc` slot on the email object; call `invalidateEmailLC(email)` after mutating address/subject fields. Same idea for `getGroupMemberSet` / `invalidateGroupCache` on email groups.
- `updateHeaderStatsFast()` — cheap header refresh with debounced nav counts; use after single-email changes.

**Panels:** `showPanel('import' | 'list')`. Dashboard and address book render into `#email-list` while staying in the `list` panel.

## Smart Views

Smart views use a **grouped rules** format (legacy flat `{ruleOperator, rules}` records are converted on the fly by `normalizeSmartView`):
```js
{
  id, name, icon,
  groupOperator: 'AND'|'OR',          // how groups combine
  groups: [{ operator: 'AND'|'OR', rules: [{ field, operator, value }] }],
  requiredTags: [],                   // always AND-combined
  excludeAutomated: true,             // default true
}
```

**Rule fields:** `fromAddr`, `fromName`, `fromDomain`, `toAddr`, `toDomain`, `ccAddr`, `ccDomain`, `subject`, `date`, `status`, `tags`, `hasAttachments`, `isSystemEmail`, plus group fields `fromInGroup`, `recipientInGroup`, `participantInGroup`

**Operators:** `contains`, `not_contains`, `equals`, `not_equals`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` (text fields); `is_true`, `is_false` (boolean fields); `in_group`, `not_in_group` (group fields); `is_between`, `is_on`, `is_after`, `is_before` (date field)

**Date rules** (`DATE_FIELDS` in rule-engine.js) are the "emails between two dates" mechanism — save a range as a smart view and it becomes a sidebar entry. They're the one rule kind that uses a second value: `is_between` stores its upper bound in `rule.value2`, so a rule is `{ field:'date', operator:'is_between', value:'2025-01-01', value2:'2025-03-31' }`. Both ends are inclusive and either may be left blank for an open-ended range; a range with neither bound set is a no-op rather than a filter matching nothing. Comparison is string comparison of `YYYY-MM-DD` keys — `localDateKey()` derives the email's key in **local** time (cached in the `_lc` slot as `dateKey`) so a rule matches the day the list shows, since `formatDate` also renders local. An email with a missing or unparseable date matches no date rule.

Because a rule can now carry two values, `collectGroupsFromDOM` reads the value cell's inputs positionally via `readRuleValues(row)` rather than looking for a specific input type — a new multi-value operator just renders its inputs in order.

Rule evaluation: `evaluateRule(email, rule)` → `applySmartViewRules(email, sv)` → used in `applyFilters()` and `renderSmartViewsSidebar()` (sidebar badges count *unread* matches).

Each smart view has an Emails/Attachments/Links tab toggle (`svSubView`); the attachments sub-view (`showSvAttachments`) lists attachments of the filtered emails, deduplicated by hash. The links sub-view (`showSvLinks`) scans the (truncated) `textBody` of the filtered emails for http(s) URLs and lists them deduplicated by URL — useful for spotting external file-transfer/cloud-storage links (WeTransfer, Dropbox, Google Drive, etc., classified via `FILE_TRANSFER_HOSTS`) that don't appear as attachments. Defaults to file-transfer links only, with a toggle to show all links; both attachment and link tables export to CSV.

## Tagging

- Tags stored as `string[]` on each email (`email.tags`); exclusions in `email.tagExclusions`
- `addTag(id, tagName?)`, `removeTag(id, tag)`, `excludeTag(id, tag)`, `unexcludeTag(id, tag)` — in the detail panel (`js/actions.js`)
- The detail panel suggests the top-5 globally used tags not already on/excluded from the email

## UI structure

```
#app
  header            — logo, header stats (#h-total, #h-unread, #h-attachments, #storage-indicator)
  #main
    #sidebar        — nav items (data-view attr), #smart-views-nav, import/export buttons
    #content
      #import-panel — storage connection checklist (EML archive, import folder) + drop zone
      #email-list-panel
        .toolbar    — #view-title, #sv-tab-toggle, search, sort
        .email-list-header
        #email-scroll → #email-list   (virtual scroll container)

#email-modal-overlay → #detail-panel  (email detail modal, j/k navigation)
#sv-modal-overlay    → #sv-modal      (smart view editor modal)
#import-progress-bar                  (bottom bar during import, with log)
#toast
```

## Adding a new feature — checklist

1. **New email action** → add button in the `det-actions` block (inside `openDetail` in `js/render.js`) + async handler in `js/actions.js`
2. **New view** → add entry to `VIEW_LABELS` in `js/state.js`, add `nav-item` in `index.html`, add case in `switchView` and `applyFilters` in `js/smart-views/routing.js`
3. **New smart view rule field** → add to `RULE_FIELDS` array in `js/smart-views/rule-engine.js`; if boolean add to `BOOL_FIELDS` (group-style fields go in `GROUP_FIELDS`, date-style in `DATE_FIELDS`); add case in `getEmailFieldValue`, and a branch in `getOperatorOptions` / `getValueInputHTML` / `evaluateRule` if the field needs its own operators or input widget
4. **New DB store** → increment `DB_VERSION` in `js/db.js`, add `createObjectStore` in `onupgradeneeded`, add wrapper calls as needed; include it in `exportData`/`importData` in `js/export.js`
   - Add it to the `stores` list in `streamBackupJson` and to `BACKUP_STORE_KEYS` + the flush order in `applyBackupStream` (both js/export.js).
   - Bodies are the exception: `streamBackupJson` re-inlines them onto each email record and `applyBackupStream` splits them back out, so the backup JSON keeps its `schemaVersion: 3` shape and stays portable in both directions.
5. **New persistent setting** → use `apiGetSetting(key)` / `apiPutSetting({ key: '...', ... })`; setting UI goes in `js/smart-views/settings.js` (`showSettings`)
6. **Any new data access** → add an `api*` function to `js/api.js` with both branches, plus the route in `email_tracker/server.py` and the method in `email_tracker/store.py` (and a test in `tests/test_server.py`). Something that can't work in v2 yet gets `data-v1-only`.

## Google Drive backup (`js/gdrive.js`)

Optional cloud backup of the full corpus to the user's own Google Drive. Config
lives in Settings (`renderGDriveSection`), state persists as the `gdrive` settings
record. Design points:

- **Auth**: Google Identity Services (GIS), lazy-loaded (`loadGisScript`) only when
  the user connects — the core app stays dependency-free/offline. The user brings
  their own OAuth Client ID (Google Cloud Console → Web application client),
  mirroring the "bring your own key" model used for the Claude API.
- **Scope**: `drive.file` only — the app can read/write just the files it creates,
  never the rest of the user's Drive.
- **Tokens** live in memory only (`gdriveAccessToken`/`gdriveTokenExpiry`), never
  persisted. `gdriveEnsureToken(interactive)` acquires/reuses a token; `gdriveFetch`
  wraps Drive REST calls with a single silent retry on 401.
- **Backups**: `gdriveBackupNow` uploads `buildBackupBlob()` (shared with
  `exportData`) as a timestamped JSON file into a `Email Tracker Backups` folder
  (`gdriveGetBackupFolder` finds-or-creates it). `gdriveMaybeAutoBackup` runs after
  import when auto-backup is on (non-interactive token only — never pops a consent
  dialog mid-workflow).
- **Restore**: `gdriveListBackups` / `gdriveRestoreBackup` download a file and feed
  it to `applyBackupStream` (shared with JSON import; skip-if-existing, never clobbers).
  The restore is applied straight off the download stream, so the backup is never
  held whole in memory.

Note: OAuth needs an http(s) origin whose domain is listed under the client's
"Authorized JavaScript origins" — it won't work from `file://`.

---

## v2 server (migration in progress)

A FastAPI app on 127.0.0.1 that owns `email.db` (SQLite, WAL) and serves the unchanged UI. Why and the acceptance criteria: `HANDOVER.md` (main checkout).

```bash
uv run --extra server python -m email_tracker serve                  # http://127.0.0.1:8767
uv run python -m email_tracker import-backup email-tracker-YYYY-MM-DD.json   # v1 export → email.db
uv run python -m email_tracker ingest ~/Downloads/email                   # .eml files/folders (skip-if-known)
uv run python -m email_tracker ingest-thunderbird [--profile DIR]        # Thunderbird mbox folders
uv run python -m email_tracker rederive                              # recompute threads + needs_my_reply
uv run python -m email_tracker backup                                # VACUUM INTO snapshot + prune
uv run python -m email_tracker install-backup-job                    # nightly LaunchAgent (02:45)
uv run python -m email_tracker install-server-job                    # server at login, KeepAlive
# Both jobs run from the checkout you install them from — use the dedicated
# worktree .claude/worktrees/server-job (detached; update it to origin/main
# after a merge, then re-run install-server-job or `launchctl kickstart -k`).
uv run --extra server --group dev pytest tests/
uv run --extra server --with playwright python tests/e2e_v2.py      # system Chrome, throwaway DB
```

Config lives outside the repo (public; the corpus is work email): `~/.config/email-tracker/config.json` (`$EMAIL_TRACKER_CONFIG`) — `db_path` (default `~/.local/share/email-tracker/email.db`, or `$EMAIL_TRACKER_DB`), `port` (8767; bank-consolidator uses 8765/8766), `allowed_hosts`, `backup_dir`, `archive_dir` (raw originals; default `eml/` beside the DB), `thunderbird_profile` (default: the profile Thunderbird opens, from `profiles.ini`), `my_addresses` (needs_my_reply is off until set — never commit them).

**Modules** (`email_tracker/`): `schema.py` (DDL + camelCase⇄column mapping; unknown record keys go to an `extra` JSON column so backups round-trip; `SCHEMA_VERSION` migrations run in `EmailStore.__init__`), `store.py` (`EmailStore`, the only writer: one connection + lock, per-thread read connections; derived state), `threading_ids.py` (thread roots), `parse.py` (raw RFC 822 → fields, stdlib `email`), `clean.py` (HTML→text, quote truncation, signature stripping — ports of parser.js), `detect.py` (automated detection — port of detection.js), `ingest.py` (the one ingest path: batches, archive, reparse), `mbox.py` (Thunderbird profiles), `maintenance.py` (Settings re-runs), `jobs.py` (background jobs the page polls), `backup_json.py` (streaming v3 JSON reader/writer — a port of `makeBackupScanner`/`applyBackupStream`), `server.py` (routes), `backup.py`, `__main__.py`.

**Ingest** (`ingest.py`) — every source arrives as raw bytes + a file name: `POST /api/ingest/eml` (the page uploads one file per request, then `POST /api/ingest/finish`), `ingest` (CLI, folders), or a message cut from an mbox (`mbox.py`). A header peek settles known ids without a full parse, so re-imports are cheap. Rules:
- id = Message-ID, else `sha256:<raw bytes>`; dates ISO 8601 UTC; addresses bare + lowercase (schema v2 normalised the v1 data the same way); attachment hashes SHA-256.
- Skip-if-known, never rewrite: tags/status/edits survive. Tombstoned ids stay out. The only change to an existing email is archiving its original if it had none (v1-imported emails).
- Originals go to `<archive_dir>/<sender domain>/<name>` — hard-linked from a source file on the same volume, copied otherwise. `GET /api/emails/{id}/eml` serves one; `POST /api/emails/{id}/reparse` re-reads it for the detail panel's Reimport button.
- Body clean-up uses the same custom patterns the Settings page edits (settings records `customQuotePatterns`, `customSignaturePatterns`, `signatureRanges`); detection uses `customAutomationPatterns` and the real headers.
- Threads and needs_my_reply are recomputed once per batch (`Batch.close()` → `rederive_if_pending`); `meta.derive_pending` makes an interrupted batch finish on the next start.

**Thunderbird** (`mbox.py`) — reads the profile directly (no Chrome `~/Library` blocklist on the server). v1's rules: separator = `From ` at file start or after a blank line; `X-Mozilla-Status` expunged messages and Trash/Junk/Drafts/… skipped. Per-folder state in `meta.mbox_state` lets a folder that only grew resume at its old end; a compacted folder is rescanned (known ids skipped by header peek). `POST /api/ingest/thunderbird` runs it as a background job; the page polls `GET /api/ingest/job/thunderbird`.

**needs_my_reply** (`EmailStore._needs_reply`) — the newest message of a thread is flagged when it's from someone else, not automated, has me in **To**, isn't a calendar response/auto-reply, and either I've written in the thread or it's a direct note (≤ `DIRECT_MAX_TO` To recipients) from someone I've emailed. Only that message carries it (`needsMyReply` on the record); the "Needs Reply" view (v2-only) lists them, and life-mcp's `email_open_actions` reads the column.

**v2 mode in the page:** `GET /` injects `window.EMAIL_V2_SERVER = true` into `<head>`; `js/api.js` reads it into `V2_SERVER` and puts `.v2-server` on `<html>`, which hides `[data-v1-only]` elements (CSS at the end of styles.css). GitHub Pages / `file://` never get the flag, so the same files run v1. The API is purpose-built — one route per UI operation — and returns v1's record shapes, so filtering, the rule engine, rendering and threading.js still run in the browser on `allEmails` (metadata only; ~27k rows is fine).

**Derived state is the server's job:** `thread_id` is persisted and recomputed after every insert/delete (v1's inReplyTo walk, plus a `References` fallback that threads replies Outlook sent without In-Reply-To). `emails_fts` (FTS5 over subject/sender/body, rowid = `emails.seq`) is refreshed on every email/body write — life-mcp's search joins on it.

**Security:** loopback bind only; `TrustedHostMiddleware` against DNS rebinding; non-GET with a foreign `Origin` → 403; request bodies must be `application/json` (415 otherwise), so a cross-site form can't write without a preflight the server never approves.

**Status:**
- *Phase 1 done:* server, schema, backup import (the 2026-09-03 export imports to exactly 27,238 emails / 75,396 attachments; re-import adds nothing), UI read/write through the API, JSON export/import, mojibake and line-break maintenance, nightly snapshots.
- *Phase 2 done:* Python ingest (.eml upload/folders + Thunderbird), archived originals (Open Original, Reimport EML), truncation/signature/detection re-runs server-side, needs_my_reply + Needs Reply view, life-mcp's email domain reads the live DB (schema-adaptive `life_mcp/domains/email.py`). On a 3,000-file sample of the v1 archive the Python parser matches v1's stored body for 99.7%; the differences are fixes (ISO-2022-JP, broken subject folding, BOMs).
- *Still v1-only (`data-v1-only`):* attachment text extraction (needs PDF/Office libraries server-side — a later step), Google Drive (superseded by snapshots/Litestream, won't be ported), Clear DB (restore a snapshot instead), the browser-side archive folder and import toggles.
- `imap_sync.py` is not part of v2 (mail arrives as manual .eml exports and via Thunderbird).

---

## Analysis: Migration from IndexedDB to SQL

*Recorded 2026-02-27 — kept as a decision record; some schema details reference stores/fields that have since been removed (e.g. issues). **Superseded 2026-09-29:** v2 went server-side (see above), which drops the no-server constraint this analysis assumed; its schema sketch informed `email_tracker/schema.py`, its WASM/OPFS sections no longer apply.*

### Motivation

The current IndexedDB approach loads the **entire** `emails` store into `allEmails` on startup, then does all filtering, searching, and sorting in JavaScript. This works well today but has clear scaling limits:

- Full-text search (`searchEmails`) is a linear scan over `allEmails`
- Smart view rule evaluation (`applySmartViewRules`) is another full scan
- `updateNavCounts` iterates `allEmails` multiple times per view-switch
- Tag/issue lookups are O(n) array operations
- Large `textBody` strings inflate memory usage proportionally to corpus size

A SQL engine (specifically SQLite via WASM) would push filtering, search, and aggregation into a compiled C engine, eliminating most of those scans.

### Viable in-browser SQL option

**SQLite WASM** — the only realistic option that preserves the no-server, no-npm constraint. Three persistence backends, in order of preference for this app:

- **`opfs-sahpool` VFS (SyncAccessHandle Pool)** — added in SQLite 3.43 (Aug 2023). Persists to the Origin Private File System but **does not require COOP/COEP headers / cross-origin isolation**, so it works on GitHub Pages out of the box. Per the official docs this is also the *fastest* OPFS backend. Trade-off: one tab at a time — a second tab opening the DB throws.
- **Default `opfs` VFS** — uses `SharedArrayBuffer` + a dedicated worker; requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. On GitHub Pages this can be enabled via the [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) shim (a client-side service worker that injects the headers). Supports multi-tab.
- **`sql.js`** — older, no OPFS, holds the DB in memory and persists as a `Uint8Array` blob to IndexedDB. No header constraints. Forfeits the memory advantage — the whole DB still has to live in RAM.

All three include the **FTS5** extension for ranked full-text search over `subject` + `textBody`.

### Proposed SQL schema

```sql
-- Core emails table (scalar fields only)
CREATE TABLE emails (
  id               TEXT PRIMARY KEY,
  message_id       TEXT,
  in_reply_to      TEXT,
  subject          TEXT,
  from_addr        TEXT,
  from_name        TEXT,
  date             TEXT,           -- ISO 8601
  text_body        TEXT,
  status           TEXT,           -- 'unread'|'read'|'replied'|'awaiting'|'actioned'
  is_actionable    INTEGER,        -- 0|1
  is_system_email  INTEGER,        -- 0|1
  manual_override  INTEGER,        -- 0|1  (manualSystemOverride)
  is_low_value     INTEGER,        -- 0|1
  has_attachments  INTEGER,        -- 0|1
  attachment_count INTEGER,
  awaiting_since   TEXT,
  thread_id        TEXT,
  imported_at      INTEGER         -- epoch ms
);

-- Normalized arrays (currently stored inline on email objects)
CREATE TABLE email_addresses (
  email_id  TEXT REFERENCES emails(id) ON DELETE CASCADE,
  role      TEXT,                  -- 'to' | 'cc' | 'ref'
  address   TEXT
);

CREATE TABLE email_tags (
  email_id  TEXT REFERENCES emails(id) ON DELETE CASCADE,
  tag       TEXT
);

CREATE TABLE email_issue_links (
  email_id  TEXT REFERENCES emails(id) ON DELETE CASCADE,
  issue_id  TEXT REFERENCES issues(id) ON DELETE CASCADE
);

-- Attachments (unchanged structure, foreign key added)
CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  email_id       TEXT REFERENCES emails(id) ON DELETE CASCADE,
  filename       TEXT,
  size           INTEGER,
  mime_type      TEXT,
  hash           TEXT,
  stored_path    TEXT,
  transmittal_ref TEXT,
  source_party   TEXT,
  document_type  TEXT,
  is_nested      INTEGER,
  parent_filename TEXT
);

-- Issues (unchanged structure)
CREATE TABLE issues (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  description  TEXT,
  status       TEXT,
  created_date TEXT,
  updated_date TEXT
);

-- Tags registry
CREATE TABLE tags (name TEXT PRIMARY KEY);

-- Smart views (rules stay as JSON — no benefit normalizing further)
CREATE TABLE smart_views (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  icon           TEXT,
  rule_operator  TEXT,            -- 'AND' | 'OR'
  rules_json     TEXT,           -- JSON array of rule objects
  exclude_automated INTEGER DEFAULT 1
);

-- Settings key-value
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

-- Email groups
CREATE TABLE email_groups (id TEXT PRIMARY KEY, name TEXT, addresses_json TEXT);

-- Tombstones for discarded email IDs
CREATE TABLE seen_ids (id TEXT PRIMARY KEY);

-- Message-ID → email-ID index (replaces msgIndex store)
CREATE INDEX idx_emails_message_id  ON emails(message_id);
CREATE INDEX idx_emails_thread_id   ON emails(thread_id);
CREATE INDEX idx_emails_date        ON emails(date);
CREATE INDEX idx_emails_from_addr   ON emails(from_addr);
CREATE INDEX idx_emails_status      ON emails(status);
CREATE INDEX idx_email_tags_tag     ON email_tags(tag);
CREATE INDEX idx_attachments_email  ON attachments(email_id);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject, text_body, from_addr, from_name,
  content='emails', content_rowid='rowid'
);
```

### Key migration challenges

| Challenge | Detail |
|---|---|
| **Array fields** | `toAddrs`, `ccAddrs`, `references`, `tags` are JS arrays today. In SQL they become junction tables (`email_addresses`, `email_tags`). Every current call site that reads/writes these must change. |
| **Smart view rules** | Rules are arbitrary JS objects; storing as `rules_json TEXT` and deserializing in JS is the pragmatic choice. SQL-side rule evaluation would require dynamic query generation — complex but possible. |
| **allEmails in-memory cache** | The entire rendering pipeline assumes `allEmails` is a populated JS array. With SQL the array could be populated lazily (paginated) or replaced by direct DB queries in `applyFilters`. The latter is a larger refactor. |
| **FTS sync** | The `emails_fts` trigger must be kept in sync on insert/update/delete. SQLite WASM supports triggers so this is handled automatically. |
| **Persistence backend choice** | The default `opfs` VFS requires COOP/COEP headers — GitHub Pages can't set them, but `coi-serviceworker` works around that. The `opfs-sahpool` VFS sidesteps the issue entirely (no SAB, no headers) at the cost of single-tab access. Either way, a `file://` open of `index.html` no longer works — a local HTTP server is needed during development. |
| **Single-file constraint** | The SQLite WASM bundle (~1.5 MB) and its worker script are external files. The app would no longer be a single `index.html`. Alternatively, inline the WASM as a base64 data URL — ugly but possible. |
| **Export/Import** | Current JSON export covers `emails` + `attachments`. A SQL export could use SQLite's `.dump` output or recreate the same JSON shape by querying and serialising. |

### DB wrapper mapping

Current IndexedDB wrappers map straightforwardly to SQL equivalents:

| Current | SQL equivalent |
|---|---|
| `dbPut('emails', record)` | `INSERT OR REPLACE INTO emails …` + upserts into junction tables |
| `dbGet('emails', id)` | `SELECT … FROM emails WHERE id = ?` + joins |
| `dbGetAll('emails')` | `SELECT … FROM emails` (could add `LIMIT`/`OFFSET` for pagination) |
| `dbGetByIndex('attachments','emailId', id)` | `SELECT … FROM attachments WHERE email_id = ?` |
| `dbDelete('emails', id)` | `DELETE FROM emails WHERE id = ?` (cascades via FK) |
| `dbClear('emails')` | `DELETE FROM emails` |

### Recommended migration path (if pursued)

1. **Spike**: drop `sql.js` into the page, prove read/write/FTS in isolation
2. **Parallel stores**: keep IndexedDB live; write new imports to SQL alongside; validate parity
3. **Switch reads**: replace `loadEmailList` to query SQL; keep `allEmails` array as a populated cache
4. **Push filtering down**: rewrite `applyFilters` to build and run a SQL `WHERE` clause; remove full-scan loops
5. **Replace allEmails cache**: render directly from paginated SQL results; virtual scrolling becomes tractable
6. **Remove IndexedDB**: delete `openDB` and all `db*` wrappers once all call sites migrated

### Verdict

**Technically feasible on GitHub Pages, but not warranted at current scale.** The original blocker — that OPFS requires COOP/COEP headers GitHub Pages can't set — has two viable workarounds: the `opfs-sahpool` VFS (SQLite ≥ 3.43) drops the SAB requirement entirely, and `coi-serviceworker` can inject the headers client-side for the standard `opfs` VFS. Either path runs on Pages today.

What *hasn't* changed is the cost/benefit balance: a migration touches every call site that reads array fields (`toAddrs`, `ccAddrs`, `tags`), trades the single-`index.html` deploy for a ~1.5 MB WASM bundle + worker, and the in-memory JS pipeline already handles 10k emails without user-visible lag (especially after the rule-engine memoization and virtual-scrolling changes). Revisit if the corpus crosses ~50k emails or full-text search latency becomes a complaint — `opfs-sahpool` is the recommended starting point at that time.
