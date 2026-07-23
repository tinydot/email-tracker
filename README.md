# Email Tracker

A client-side web app for triaging, tagging, and analysing email archives. Runs
entirely in the browser — no build step, no npm, no server. Open `index.html`
and go.

## Features

- **Import `.eml` files** by drag-and-drop or folder pick (uses the File System
  Access API). Attachments are stored locally and text-extracted where possible.
- **Threading** via `Message-ID` / `In-Reply-To` / `References` headers.
- **System / automated-email detection** with user-editable patterns; auto-hide
  bulk noise from the main views.
- **Tags** — per-email and bulk tagging across a view, with optional auto-tag
  rules.
- **Smart Views** — saved filters built from rules over sender, recipient,
  subject, status, tags, attachments, etc. Combine with AND/OR.
- **Issue tracker** with email↔issue linking.
- **Transmittal register** for attachment-heavy workflows.
- **AI assistance**:
  - Online: tag a single email or bulk-tag a view via the Claude API
    (your own key, stored locally).
  - Offline: export a view, run `tools/analyze.py` against a local Ollama
    instance, import the resulting `insights.json` back into the app.
  - Similarity search over the locally-generated embeddings.
- **Address book** of contact profiles (role, projects) used to enrich AI prompts.
- **Action items** view — flat list of structured action items across all
  analysed emails, filterable by open / resolved / deferred.
- **JSON export / import** of the full corpus.
- **Google Drive backup** (optional) — back up the full corpus to a folder in
  your own Google Drive, with one-click restore and optional auto-backup after
  each import. Uses your own OAuth Client ID and the least-privilege
  `drive.file` scope (the app only ever sees files it created). See Settings →
  Google Drive backup.

All data lives in IndexedDB in your browser. Nothing is sent anywhere unless
you explicitly use the Claude API integration.

## Running

Just open `index.html` in a modern browser (Chromium-based recommended for
the File System Access API). No server, no install.

## Importing emails

The app reads `.eml` files. Two companion scripts produce them:

| Source | Script | Platform |
|---|---|---|
| Outlook `.pst` archive | `pst_to_eml.py` | Windows + Outlook |
| IMAP account (Outlook.com, Gmail, …) | `imap_sync.py` | Any (Python stdlib) |

See `pst_to_eml_README.md` and `imap_sync_README.md` for usage.

## Offline AI analysis

`tools/analyze.py` reads an email export from the app, sends each email to a
local [Ollama](https://ollama.com/) instance, and writes `insights.json` (with
summaries, action items, and embeddings) that you import back via
**Settings → Local AI**. No data leaves your machine. See `tools/README.md`.

## Project layout

```
index.html        ← HTML structure (~200 lines)
css/styles.css    ← all styles
js/               ← single-global-scope modules, loaded via <script src>
  db.js, parser.js, detection.js, import.js, threading.js, state.js,
  smart-views/, ai/, render.js, actions.js, data-load.js, export.js,
  address-book.js, issues.js, action-items.js, helpers.js, init.js
imap_sync.py, pst_to_eml.py    ← email-source companion scripts
tools/analyze.py               ← offline AI analysis pipeline
fix-mojibake.js                ← one-off DevTools repair script
```

See `CLAUDE.md` for the detailed code map, data model, and contributor notes.
