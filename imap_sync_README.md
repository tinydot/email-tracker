# imap_sync.py

Incrementally sync all folders from an IMAP account as individual `.eml` files, ready to import into the email-tracker app.

## Requirements

- **Python 3.10+**
- **No third-party libraries** — uses only `imaplib`, `email`, `ssl`, and `json` from the standard library

## Outlook.com setup

Before running the script you need an **App Password** (required when two-step verification is enabled, which is strongly recommended):

1. Go to <https://account.microsoft.com/security>
2. Open **Advanced security options → App passwords**
3. Create a new app password for "Python IMAP sync"
4. Use that 16-character password with `--user`

IMAP must also be enabled in Outlook.com:

> Settings → Mail → Sync email → POP and IMAP → **IMAP enabled: On**

## Usage

```bash
python imap_sync.py --user you@outlook.com --output ./emails-export
```

The script will prompt for your password (or App Password) securely.  To pass it non-interactively:

```bash
python imap_sync.py --user you@outlook.com --password "abcd efgh ijkl mnop" --output ./emails-export
```

### Sync specific folders only

```bash
python imap_sync.py --user you@outlook.com --output ./emails-export \
  --folders INBOX "Sent Items" Archive
```

### Full re-sync (ignore saved state)

```bash
python imap_sync.py --user you@outlook.com --output ./emails-export --reset
```

## All options

| Flag | Default | Description |
|---|---|---|
| `--user` | *(required)* | IMAP login / email address |
| `--password` | *(prompted)* | Password or app-password |
| `--host` | `imap-mail.outlook.com` | IMAP server hostname |
| `--port` | `993` | IMAP port (SSL) |
| `--output` | `./emails-export` | Output directory for `.eml` files |
| `--folders FOLDER …` | *(all folders)* | Sync only the listed folder names |
| `--state-file PATH` | `<output>/../imap_sync_state.json` | Path to the sync-state file |
| `--reset` | off | Ignore saved state; re-download everything |
| `--batch-size N` | `50` | Messages fetched per IMAP round-trip |

## How sync tracking works

A JSON state file (`imap_sync_state.json`) is written next to the output folder.  It records, per account and per IMAP folder:

- **`uidvalidity`** — IMAP's per-folder epoch counter.  If the server rebuilds a mailbox and resets UIDs, this value changes and the script automatically re-syncs that folder from scratch.
- **`synced_uids`** — The list of IMAP UIDs already downloaded.  On the next run only UIDs not in this list are fetched.

```json
{
  "you@outlook.com": {
    "INBOX": {
      "uidvalidity": 638710964,
      "synced_uids": [1, 2, 3, 17, 42]
    },
    "Sent Items": {
      "uidvalidity": 638710965,
      "synced_uids": [1, 2, 3]
    }
  }
}
```

State is written to disk **after every folder**, so if the script is interrupted mid-run the next run will continue from where it left off without re-downloading already-saved messages.

## Output

All folders are flattened into a single output directory — no sub-folder structure is created.  Because email-tracker uses **Smart Views** for filtering, the physical folder is irrelevant.

Each `.eml` file:
- Contains the original RFC 822 message bytes exactly as delivered by the server
- Has an extra `X-Original-Folder` header prepended so Smart View rules can still filter by source folder (e.g. `fromDomain contains "X-Original-Folder: Sent Items"` — or just inspect the raw header field directly once header-based rules are added)
- Is named `<folder>_<uid>_<subject>.eml`, e.g. `INBOX_42_Re_ Project update.eml`

```
emails-export/
  INBOX_1_Welcome to Outlook.eml
  INBOX_42_Re_ Project update.eml
  Sent_Items_3_Re_ Invoice #1234.eml
  Archive_17_Q3 report.eml
  …
imap_sync_state.json
```

## Progress output

```
Connecting to imap-mail.outlook.com:993 …
Logging in as you@outlook.com …
Listing folders …
Found 8 folder(s).
Output directory: /home/alice/emails-export

  'INBOX' — 143 new message(s) to download …
     143 saved
  'Sent Items' — 87 new message(s) to download …
      87 saved
  'Archive' — up to date (1024 messages)
  …

──────────────────────────────────────────────────
Done — 230 new email(s) downloaded.
State saved to:  /home/alice/imap_sync_state.json
Drop  '/home/alice/emails-export'  into the email-tracker import panel.
```

## Running on a schedule

### Linux / macOS — cron

```cron
# Sync every 30 minutes, appending to a log file
*/30 * * * * python /path/to/imap_sync.py \
  --user you@outlook.com \
  --password "your-app-password" \
  --output /path/to/emails-export \
  >> /var/log/imap_sync.log 2>&1
```

### Windows — Task Scheduler

Create a basic task that runs:

```
python C:\email-tracker\imap_sync.py --user you@outlook.com --password "app-pw" --output C:\emails-export
```

Set the trigger to "Daily" → "Repeat task every: 30 minutes".

## Importing into email-tracker

Once the sync completes, open `index.html` in your browser and use the **Import** panel to drag-and-drop the output folder.  The email-tracker app parses all `.eml` files recursively — re-importing the same folder is safe because email-tracker deduplicates by `Message-ID`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Login failed: [AUTHENTICATIONFAILED]` | Use an App Password, not your account password.  Generate one at account.microsoft.com/security |
| `Login failed: … please enable IMAP` | Enable IMAP in Outlook.com → Settings → Mail → Sync email |
| `Connection failed` | Check host/port; try `--host outlook.office365.com` for work/school accounts |
| Duplicate files after re-run | Normal — email-tracker deduplicates on import by `Message-ID`; extra `.eml` files are harmless |
| State file grows large | UIDs are integers; a 10 000-message account produces ~100 KB state.  Safe to leave indefinitely |
| Want to sync only recent mail | Use `--folders INBOX` and optionally `--reset` once to grab a clean initial batch, then let incremental sync take over |

## Other IMAP providers

The script works with any IMAP server.  Change `--host` and `--port` as needed:

| Provider | Host | Port |
|---|---|---|
| Outlook.com | `imap-mail.outlook.com` | `993` |
| Office 365 (work) | `outlook.office365.com` | `993` |
| Gmail | `imap.gmail.com` | `993` |
| iCloud | `imap.mail.me.com` | `993` |
| Yahoo | `imap.mail.yahoo.com` | `993` |

Gmail and Yahoo require an App Password when 2FA is enabled (same process as Outlook.com).
