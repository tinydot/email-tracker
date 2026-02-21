# Email Tracker

A single-file, client-side email tracker built as a self-contained HTML app. No build step, no server, no dependencies beyond Google Fonts.

## Architecture

Everything lives in `email-tracker.html` — CSS, HTML, and JavaScript are all inline.

**Storage:** IndexedDB (`EmailTracker`, version 2) with stores for emails, attachments, and issues. Helper wrappers (`dbPut`, `dbGet`, `dbGetAll`, `dbGetByIndex`, `dbDelete`, `dbClear`) abstract raw IDB requests.

**Parsing:** EML files are parsed entirely in the browser (`parseEML`, `parseMIMEPart`, `decodePart`, `decodeBody`, `decodeQP`). Supports multi-part MIME, quoted-printable, base64, and encoded-word headers.

**Threading:** Emails are linked via `Message-ID` / `In-Reply-To` / `References` headers. `linkThreads`, `getThreadRoot`, `getThreadEmails`, and `getThreadDepth` handle the thread graph.

**File System Access API:** Used for folder import (`handleFolderImport`, `collectEmlFilesRecursively`) and optional EML archiving/attachment storage to disk. Falls back gracefully when the API is unavailable.

**Views:** `showPanel` / `switchView` control which panel is visible (import, inbox, actionable, issues, settings). `renderEmailList` and `openDetail` handle list and detail rendering.

## Key Functions

| Function | Purpose |
|---|---|
| `handleFiles` / `handleFolderImport` | Entry points for importing EML files |
| `processFilesForImport` | Pipeline that parses, deduplicates, and stores emails |
| `parseEML` | Full EML → structured object parser |
| `linkThreads` | Rebuilds the thread graph from stored emails |
| `detectActionable` | Keyword-based heuristic to flag action-required emails |
| `saveAttachmentToDisk` | Writes attachments to a user-chosen directory via File System Access API |
| `renderEmailList` / `openDetail` | Main UI rendering functions |

## Development Notes

- Open `email-tracker.html` directly in Chrome or Edge (File System Access API required for folder import and disk storage features).
- No build tools. Edit the file directly; refresh the browser to see changes.
- IndexedDB schema version is `DB_VERSION` (currently `2`). Increment it and add migration logic in `openDB`'s `onupgradeneeded` handler when changing the schema.
- `simpleHash` is used for attachment deduplication — it is not cryptographically secure.
- The app uses `localStorage` for settings (nested attachments toggle, organize-EML toggle).
