# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Email Tracker — Claude Context

## Project at a glance

A client-side web app with no build step, no npm, no server, and no external runtime dependencies. Open `index.html` in a browser and it runs entirely in-browser using the File System Access API and IndexedDB.

```
email-tracker/
├── index.html        ← HTML structure only (~190 lines)
├── css/
│   └── styles.css    ← all styles (~1050 lines)
└── js/
    ├── db.js         ← IndexedDB wrapper (openDB + db* helpers)
    ├── parser.js     ← EML parser (MIME, encodings, signature/quote stripping)
    ├── detection.js  ← system/automated email detection patterns
    ├── import.js     ← import pipeline, attachment/EML file storage, reimport
    ├── threading.js  ← msgId/emailId indexes + memoized thread root/depth caches
    ├── state.js      ← global state variables + showPanel
    ├── smart-views/  ← smart views (split into focused modules)
    │   ├── rule-engine.js ← RULE_FIELDS, evaluateRule, applySmartViewRules, lowercase caches
    │   ├── editor.js      ← smart view editor modal (grouped rules, required tags)
    │   ├── sidebar.js     ← renderSmartViewsSidebar, sv tab toggle, sv attachments view
    │   ├── routing.js     ← switchView, applyFilters, searchEmails, applySort
    │   └── settings.js    ← showSettings: email groups, custom patterns, maintenance
    ├── render.js     ← virtual-scrolled email list, detail modal, body edit/truncation
    ├── actions.js    ← email actions (tags, automated toggle, delete)
    ├── data-load.js  ← loadEmailList, updateHeaderStats, updateNavCounts, backfill
    ├── export.js     ← JSON export/import, clearDB, discard automated
    ├── address-book.js ← contact profiles (name, role, projects)
    ├── dashboard.js  ← email volume over time, import activity, sender domains
    ├── helpers.js    ← drag & drop, formatDate, escHtml, toast
    └── init.js       ← init(), keyboard shortcuts (j/k, Escape)
```

All JS files share a single global scope (loaded via `<script src>` tags in `index.html`), so there are no module imports. **Script load order matters** — load order is: db, parser, detection, import, threading, state, smart-views/{rule-engine, editor, sidebar, routing, settings}, render, actions, data-load, export, address-book, dashboard, helpers, init. The section banners (`// ═══…`) within each file mark sub-sections.

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
  id,             // messageId or "filename-date"
  messageId,      // RFC Message-ID header
  inReplyTo,      // RFC In-Reply-To header
  references,     // array of referenced message IDs
  subject,
  fromAddr,       // sender email
  fromName,       // sender display name
  toAddrs,        // array of recipient emails
  ccAddrs,        // array of CC emails
  date,           // ISO string
  textBody,       // plain-text body (signature/quote-stripped at import)
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

### IndexedDB stores (`DB_VERSION = 9` in `js/db.js`)
- `emails` — email records (indexes: messageId, threadId, date, fromAddr, status, isActionable, importedAt)
- `attachments` — attachment metadata (indexes: `emailId`, `hash`)
- `tags` — global tag registry (keyPath: `name`) — note: tags are also stored inline on each email
- `msgIndex` — messageId → emailId mapping
- `smartViews` — user-defined filter views (keyPath: `id`)
- `settings` — key-value store (custom automation/quote/signature patterns, signature ranges, attach text limit, …)
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

**DB writes:** always `await dbPut('emails', email)` — email objects in `allEmails` are mutated in-place, then saved. `selectedEmail` is the same object reference, so no separate sync is needed.

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

**Rule fields:** `fromAddr`, `fromName`, `fromDomain`, `toAddr`, `toDomain`, `ccAddr`, `ccDomain`, `subject`, `status`, `tags`, `hasAttachments`, `isSystemEmail`, plus group fields `fromInGroup`, `recipientInGroup`, `participantInGroup`

**Operators:** `contains`, `not_contains`, `equals`, `not_equals`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` (text fields); `is_true`, `is_false` (boolean fields); `in_group`, `not_in_group` (group fields)

Rule evaluation: `evaluateRule(email, rule)` → `applySmartViewRules(email, sv)` → used in `applyFilters()` and `renderSmartViewsSidebar()` (sidebar badges count *unread* matches).

Each smart view has an Emails/Attachments tab toggle (`svSubView`); the attachments sub-view (`showSvAttachments`) lists attachments of the filtered emails, deduplicated by hash.

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
      #import-panel — drop zone + folder import
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
3. **New smart view rule field** → add to `RULE_FIELDS` array in `js/smart-views/rule-engine.js`; if boolean add to `BOOL_FIELDS` (group-style fields go in `GROUP_FIELDS`); add case in `getEmailFieldValue`
4. **New DB store** → increment `DB_VERSION` in `js/db.js`, add `createObjectStore` in `onupgradeneeded`, add wrapper calls as needed; include it in `exportData`/`importData` in `js/export.js`
5. **New persistent setting** → use `dbGet/dbPut('settings', { key: '...', ... })`; setting UI goes in `js/smart-views/settings.js` (`showSettings`)

---

## Analysis: Migration from IndexedDB to SQL

*Recorded 2026-02-27 — kept as a decision record; some schema details reference stores/fields that have since been removed (e.g. issues).*

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
