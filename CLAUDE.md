# Email Tracker — Claude Context

## Project at a glance

A **single-file** client-side web app (`index.html`, ~4800 lines).
No build step, no npm, no server. Open the file in a browser and it runs entirely in-browser using the File System Access API and IndexedDB.

```
email-tracker/
└── index.html   ← everything: HTML + CSS + JS in one file
```

## Architecture

The file is organized into clearly delimited sections marked by `// ═══…` banners:

| Line range | Section |
|---|---|
| 1–1154 | HTML + CSS (layout, sidebar, modals, styles) |
| 1155–1280 | **DB** — IndexedDB wrapper (`dbGet`, `dbPut`, `dbGetAll`, `dbDelete`, `dbClear`, `dbGetByIndex`) |
| 1281–1766 | **EML Parser** — parses raw `.eml` text into structured objects (`parseEML`) |
| 1767–1841 | **System email detection** — pattern matching to flag automated/bulk email |
| 1842–2444 | **Import pipeline** — file/folder import, attachment storage, EML organization |
| 2445–2551 | **Threading** — links emails by `Message-ID` / `In-Reply-To` headers |
| 2552–2874 | **State + Smart Views** — global state vars, view switching, smart view CRUD + rule engine |
| 2875–3065 | **Settings panel** — custom automation patterns, danger zone actions |
| 3066–3172 | **View routing** — `switchView`, `applyFilters`, `applySort`, `searchEmails` |
| 3173–3605 | **Render** — `renderEmailList`, `renderBadge`, `selectEmail`, `openDetail`, tags UI, threading UI |
| 3606–3956 | **Transmittal Register** — attachment metadata table with inline editing |
| 3957–4055 | **Email actions** — `setStatus`, `toggleActionable`, `bulkUnmarkActionable` |
| 4056–4176 | **Bulk Tagging** — `refreshBulkTagBar`, `bulkAddTagToView`, `bulkRemoveTagFromView`, `addTag`, `removeTag` |
| 4177–4293 | **Data load** — `loadEmailList`, `updateHeaderStats`, `updateNavCounts` |
| 4294–4381 | **Export / Import / Clear** — JSON export/import, `clearDB` |
| 4382–4749 | **Issue Tracker** — CRUD for issues, email↔issue linking |
| 4750–4843 | **Utilities + init** — `formatDate`, `escHtml`, `toast`, keyboard shortcuts, `init()` |

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

1. **New email action** → add button in `renderDetailActions` (inside `openDetail`) + async handler function
2. **New view** → add entry to `VIEW_LABELS`, add `nav-item` in sidebar HTML, add case in `switchView` and `applyFilters`
3. **New smart view rule field** → add to `RULE_FIELDS` array; if boolean add to `BOOL_FIELDS`; add case in `getEmailFieldValue`
4. **New DB store** → increment `DB_VERSION`, add `createObjectStore` in `onupgradeneeded`, add wrapper calls as needed
5. **New persistent setting** → use `dbGet/dbPut('settings', { key: '...', ... })`
