# Email Tracker — Claude Context

## Project at a glance

A client-side web app with no build step, no npm, no server. Open `index.html` in a browser and it runs entirely in-browser using the File System Access API and IndexedDB.

```
email-tracker/
├── index.html        ← HTML structure only (~200 lines)
├── css/
│   └── styles.css    ← all styles (~1078 lines)
└── js/
    ├── db.js         ← IndexedDB wrapper
    ├── parser.js     ← EML parser + attachment text extraction
    ├── detection.js  ← system/automated email detection
    ├── import.js     ← import pipeline + attachment file storage
    ├── threading.js  ← thread linking + thread computation
    ├── state.js      ← global state variables + panel switching
    ├── smart-views/  ← smart views (split into focused modules)
    │   ├── rule-engine.js ← RULE_FIELDS, evaluateRule, applySmartViewRules, loadSmartViews
    │   ├── editor.js      ← smart view editor modal (build, show, save, delete)
    │   ├── sidebar.js     ← renderSmartViewsSidebar, tab toggle, sv attachments view
    │   ├── routing.js     ← switchView, applyFilters, searchEmails, applySort
    │   ├── auto-tag.js    ← auto-tag rules engine + CRUD UI
    │   ├── ai.js          ← Claude API key, aiTagEmail, bulkAiTagView, prompt config
    │   └── settings.js    ← showSettings, email groups, custom patterns, maintenance
    ├── render.js     ← renderEmailList, openDetail, transmittal register
    ├── actions.js    ← email actions + bulk tagging
    ├── data-load.js  ← loadEmailList, updateHeaderStats, updateNavCounts
    ├── export.js     ← JSON export/import, clearDB, danger zone
    ├── issues.js     ← issue tracker CRUD, email↔issue linking
    ├── helpers.js    ← drag & drop, formatDate, escHtml, toast
    └── init.js       ← init(), keyboard shortcuts
```

All JS files share a single global scope (loaded via `<script src>`), so there are no module imports. The section banners (`// ═══…`) within each file mark sub-sections.

## Data model

### Email record (stored in IndexedDB `emails` store)
```js
{
  id,            // messageId or "filename-date"
  messageId,     // RFC Message-ID header
  inReplyTo,     // RFC In-Reply-To header
  references,    // array of referenced message IDs
  subject,
  fromAddr,      // sender email
  fromName,      // sender display name
  toAddrs,       // array of recipient emails
  ccAddrs,       // array of CC emails
  date,          // ISO string
  textBody,      // plain-text body
  status,        // 'unread' | 'read' | 'replied' | 'awaiting' | 'actioned'
  isActionable,  // boolean — user-flagged
  isSystemEmail, // boolean — auto-detected automated/bulk email
  hasAttachments,
  attachmentCount,
  tags,          // string[]
  linkedIssues,  // string[] of issue IDs
  importedAt,    // timestamp
}
```

### IndexedDB stores
- `emails` — email records
- `attachments` — attachment metadata (with `emailId` index)
- `tags` — global tag registry (keyPath: `name`) — note: tags are also stored inline on each email
- `msgIndex` — messageId → emailId mapping for O(1) thread lookups
- `issues` — issue tracker records
- `smartViews` — user-defined filter views (keyPath: `id`)
- `settings` — key-value store (e.g. `customAutomationPatterns`)

## Key global state variables
```js
allEmails      // full email array loaded from DB
filteredEmails // currently displayed subset (result of applyFilters())
currentView    // 'all' | 'unread' | 'actionable' | 'awaiting' | 'threads' |
               // 'attachments' | 'automated' | 'issues' | 'transmittals' | 'sv-<id>'
currentSort    // 'date-desc' | 'date-asc' | 'from' | 'subject'
searchTerm     // active search string
selectedEmail  // currently open email object
smartViews     // array loaded from DB on init
```

## Important patterns

**Rendering flow:** `switchView(view)` → `applyFilters()` → `renderEmailList()` → `refreshBulkTagBar()`

**Filtering:** `applyFilters()` rebuilds `filteredEmails` from `allEmails` by applying:
1. Smart view rules (`applySmartViewRules`) or built-in view filters
2. System email exclusion (all views except `automated`)
3. Full-text search
4. Sort

**DB writes:** always `await dbPut('emails', email)` — the `allEmails` array is mutated in-place, then saved.

**Panels:** `showPanel('import' | 'progress' | 'list')` — issues and transmittals render into `#email-list` while staying in the `list` panel.

**Thread linking:** `buildThreadCache()` is called once after load; `rebuildMsgIdIndex()` is called on each `applyFilters()`.

## Smart Views

Each smart view object:
```js
{ id, name, icon, ruleOperator: 'AND'|'OR', rules: [{ field, operator, value }] }
```

**Rule fields:** `fromAddr`, `fromName`, `fromDomain`, `toAddr`, `toDomain`, `ccAddr`, `ccDomain`, `subject`, `status`, `tags`, `hasAttachments`, `isActionable`, `isSystemEmail`

**Operators:** `contains`, `not_contains`, `equals`, `not_equals`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` (text fields); `is_true`, `is_false` (boolean fields)

Rule evaluation: `evaluateRule(email, rule)` → `applySmartViewRules(email, sv)` → used in `applyFilters()` and `renderSmartViewsSidebar()`.

## Tagging

- Tags stored as `string[]` on each email (`email.tags`)
- Single-email: `addTag(id)`, `removeTag(id, tag)` — in the detail panel
- Bulk (current view): `bulkAddTagToView()`, `bulkRemoveTagFromView(tag)` — via the bulk tag bar below the toolbar
- `refreshBulkTagBar()` is called from `renderEmailList()` and `switchView()` to update/hide the bar

## UI structure

```
#app
  header          — logo, header stats
  #main
    #sidebar      — nav items (data-view attr), smart views, storage indicator
    #content
      #import-panel
      #progress-panel
      #email-list-panel
        .toolbar
        #bulk-tag-bar    ← shown in all email-list views; hidden for issues/transmittals
        .email-list-header
        #email-list

#email-modal-overlay → #detail-panel   (email detail modal)
#sv-modal-overlay    → #sv-modal       (smart view editor modal)
#toast
```

## Adding a new feature — checklist

1. **New email action** → add button in `renderDetailActions` (inside `openDetail` in `js/render.js`) + async handler in `js/actions.js`
2. **New view** → add entry to `VIEW_LABELS` in `js/state.js`, add `nav-item` in `index.html`, add case in `switchView` and `applyFilters` in `js/smart-views/routing.js`
3. **New smart view rule field** → add to `RULE_FIELDS` array in `js/smart-views/rule-engine.js`; if boolean add to `BOOL_FIELDS`; add case in `getEmailFieldValue`
4. **New DB store** → increment `DB_VERSION` in `js/db.js`, add `createObjectStore` in `onupgradeneeded`, add wrapper calls as needed
5. **New persistent setting** → use `dbGet/dbPut('settings', { key: '...', ... })`; setting UI goes in `js/smart-views/settings.js`

---

## Analysis: Migration from IndexedDB to SQL

*Recorded 2026-02-27*

### Motivation

The current IndexedDB approach loads the **entire** `emails` store into `allEmails` on startup, then does all filtering, searching, and sorting in JavaScript. This works well today but has clear scaling limits:

- Full-text search (`searchEmails`) is a linear scan over `allEmails`
- Smart view rule evaluation (`applySmartViewRules`) is another full scan
- `updateNavCounts` iterates `allEmails` multiple times per view-switch
- Tag/issue lookups are O(n) array operations
- Large `textBody` strings inflate memory usage proportionally to corpus size

A SQL engine (specifically SQLite via WASM) would push filtering, search, and aggregation into a compiled C engine, eliminating most of those scans.

### Viable in-browser SQL option

**SQLite WASM + OPFS** — the only realistic option that preserves the no-server, no-npm constraint:

- [sqlite.org/wasm](https://sqlite.org/wasm) ships an official WASM build usable via a `<script>` CDN tag
- Persistence via **Origin Private File System** (OPFS) — a sandboxed virtual filesystem available in all modern browsers
- Full **FTS5** extension is included, enabling proper ranked full-text search over `subject` + `textBody`
- A SharedArrayBuffer + Worker thread is required for OPFS access (needs `Cross-Origin-Isolation` headers — a deployment consideration)

Alternative: **sql.js** (older, no OPFS, stores in memory and exports as a `Uint8Array` blob to IndexedDB). Simpler to set up but forfeits the memory advantage.

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
| **Array fields** | `toAddrs`, `ccAddrs`, `references`, `tags`, `linkedIssues` are JS arrays today. In SQL they become junction tables (`email_addresses`, `email_tags`, `email_issue_links`). Every current call site that reads/writes these must change. |
| **Smart view rules** | Rules are arbitrary JS objects; storing as `rules_json TEXT` and deserializing in JS is the pragmatic choice. SQL-side rule evaluation would require dynamic query generation — complex but possible. |
| **allEmails in-memory cache** | The entire rendering pipeline assumes `allEmails` is a populated JS array. With SQL the array could be populated lazily (paginated) or replaced by direct DB queries in `applyFilters`. The latter is a larger refactor. |
| **FTS sync** | The `emails_fts` trigger must be kept in sync on insert/update/delete. SQLite WASM supports triggers so this is handled automatically. |
| **OPFS + Cross-Origin-Isolation** | OPFS requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. For a local `file://` open this is a blocker — a small local HTTP server (e.g. `python -m http.server`) or Electron wrapper would be needed. |
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

**Not applicable for this deployment.** The app is hosted on GitHub Pages, which cannot serve custom HTTP headers. SQLite WASM + OPFS requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — both blocked on GitHub Pages. The `sql.js` alternative (no OPFS, memory-only) offers no advantage over IndexedDB at the current scale. At 10k emails with no performance complaints, IndexedDB + in-memory JS remains the right choice.
