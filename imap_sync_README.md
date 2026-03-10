# imap_sync.py

Incrementally sync all folders from an IMAP account as individual `.eml` files, ready to import into the email-tracker app.

## Requirements

- **Python 3.10+**
- **Standard library only** for basic auth (`imaplib`, `email`, `ssl`, `json`)
- **`msal`** for OAuth2 / Modern Auth: `pip install msal`

---

## Authentication methods

### Method A — Basic auth with App Password (personal Outlook.com)

Only available on personal Microsoft accounts with 2-step verification enabled.

1. Go to <https://account.microsoft.com/security>
2. **Advanced security options → App passwords → Create a new app password**
3. Use the 16-character password in place of your real password

Also enable IMAP: **Outlook.com → Settings → Mail → Sync email → POP and IMAP → IMAP enabled: On**

```bash
python imap_sync.py --user you@outlook.com --output ./emails-export
# prompts securely for the app password
```

---

### Method B — OAuth2 / Modern Auth (company Exchange / Office 365)

This is the correct method for work accounts (`you@company.com`).  No App Password needed — authentication happens via a browser sign-in with your normal company credentials (including MFA if required).

#### Step 1 — Register an app in Azure

> If your company has an IT admin, ask them to do this, or ask them to grant you access to the Azure Portal.

1. Sign in to the **Azure Portal**: <https://portal.azure.com>
2. Go to **Azure Active Directory → App registrations → New registration**
3. Fill in:
   - **Name**: `email-tracker IMAP sync` (any name)
   - **Supported account types**: *Accounts in this organizational directory only* (single tenant) — or *Accounts in any organizational directory* if you want it to work across tenants
   - **Redirect URI**: leave blank (not needed for Device Code flow)
4. Click **Register**
5. Copy the **Application (client) ID** — you'll use this as `--client-id`
6. Copy the **Directory (tenant) ID** — you'll use this as `--tenant`

#### Step 2 — Add the IMAP permission

1. In your new app registration, go to **API permissions → Add a permission**
2. Choose **APIs my organization uses** → search for **Office 365 Exchange Online**
3. Select **Delegated permissions** → tick `IMAP.AccessAsUser.All`
4. Click **Add permissions**
5. Click **Grant admin consent for \<your org\>** (requires an admin account — ask IT if needed)

#### Step 3 — Enable public client flow

1. In the app registration go to **Authentication → Advanced settings**
2. Set **Allow public client flows** to **Yes**
3. Click **Save**

#### Step 4 — Run the sync

```bash
pip install msal

python imap_sync.py \
  --user you@company.com \
  --auth oauth2 \
  --client-id 00000000-0000-0000-0000-000000000000 \
  --tenant  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --host outlook.office365.com \
  --output ./emails-export
```

**First run** — the script prints a short URL and a one-time code:

```
────────────────────────────────────────────────────────────
To sign in, use a web browser to open https://microsoft.com/devicelogin
and enter the code  ABCD-EFGH  to authenticate.
────────────────────────────────────────────────────────────
Waiting for authentication …
```

Open the URL in any browser, enter the code, and sign in with your company account.  The script continues automatically once authenticated.

**Subsequent runs** — the access token (and its refresh token) are cached in `imap_sync_token_cache.json` next to the output folder.  The script reuses the cached token silently — no browser interaction needed until the refresh token expires (~90 days for most tenants).

---

## Usage

```bash
# Basic auth
python imap_sync.py --user you@outlook.com --output ./emails-export

# OAuth2
python imap_sync.py --user you@company.com --auth oauth2 \
    --client-id <id> --tenant <tenant-id> \
    --host outlook.office365.com --output ./emails-export

# Sync specific folders only
python imap_sync.py --user you@company.com --auth oauth2 \
    --client-id <id> --tenant <tenant-id> \
    --host outlook.office365.com --output ./emails-export \
    --folders INBOX "Sent Items" Archive

# Full re-sync (ignore saved state)
python imap_sync.py --user you@company.com --auth oauth2 \
    --client-id <id> --output ./emails-export --reset
```

## All options

| Flag | Default | Description |
|---|---|---|
| `--user` | *(required)* | Email address / IMAP login |
| `--auth` | `basic` | `basic` (password) or `oauth2` (Modern Auth) |
| `--password` | *(prompted)* | Password or app-password — `basic` only |
| `--client-id UUID` | *(required for oauth2)* | Azure app registration Client ID |
| `--tenant TENANT` | `common` | Azure tenant ID, `common`, `organizations`, or `consumers` |
| `--token-cache PATH` | `<output>/../imap_sync_token_cache.json` | OAuth2 token cache file |
| `--host` | `imap-mail.outlook.com` | IMAP server hostname |
| `--port` | `993` | IMAP port (SSL) |
| `--output` | `./emails-export` | Output directory for `.eml` files |
| `--folders FOLDER …` | *(all folders)* | Sync only the listed folder names |
| `--state-file PATH` | `<output>/../imap_sync_state.json` | Sync state file path |
| `--reset` | off | Ignore saved state; re-download everything |
| `--batch-size N` | `50` | Messages fetched per IMAP round-trip |

## How sync tracking works

A JSON state file (`imap_sync_state.json`) is written next to the output folder.  It records, per account and per IMAP folder:

- **`uidvalidity`** — IMAP's per-folder epoch counter.  If the server rebuilds a mailbox and resets UIDs, this value changes and the script automatically re-syncs that folder from scratch.
- **`synced_uids`** — The list of IMAP UIDs already downloaded.  On the next run only UIDs not in this list are fetched.

```json
{
  "you@company.com": {
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

State is written to disk **after every folder**, so if the script is interrupted mid-run the next run continues from where it left off without re-downloading already-saved messages.

## Output

All folders are flattened into a single output directory — no sub-folder structure is created.  Because email-tracker uses **Smart Views** for filtering, the physical folder is irrelevant.

Each `.eml` file:
- Contains the original RFC 822 message bytes exactly as delivered by the server
- Has an extra `X-Original-Folder` header prepended so Smart View rules can filter by source folder
- Is named `<folder>_<uid>_<subject>.eml`, e.g. `INBOX_42_Re_ Project update.eml`

```
emails-export/
  INBOX_1_Welcome to Outlook.eml
  INBOX_42_Re_ Project update.eml
  Sent_Items_3_Re_ Invoice #1234.eml
  Archive_17_Q3 report.eml
  …
imap_sync_state.json
imap_sync_token_cache.json   ← OAuth2 only; contains refresh token, keep secure
```

## Running on a schedule

### Linux / macOS — cron

```cron
# Sync every 30 minutes (OAuth2 — token cache handles auth silently)
*/30 * * * * python /path/to/imap_sync.py \
  --user you@company.com \
  --auth oauth2 \
  --client-id 00000000-0000-0000-0000-000000000000 \
  --tenant xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --host outlook.office365.com \
  --output /path/to/emails-export \
  >> /var/log/imap_sync.log 2>&1
```

### Windows — Task Scheduler

Create a basic task that runs:

```
python C:\email-tracker\imap_sync.py --user you@company.com --auth oauth2 --client-id <id> --tenant <tenant-id> --host outlook.office365.com --output C:\emails-export
```

Set the trigger to "Daily" → "Repeat task every: 30 minutes".

> The first manual run must be done in an interactive terminal so the device-code browser sign-in can complete.  Scheduled runs after that are silent.

## Importing into email-tracker

Once the sync completes, open `index.html` in your browser and use the **Import** panel to drag-and-drop the output folder.  The email-tracker app parses all `.eml` files recursively — re-importing the same folder is safe because email-tracker deduplicates by `Message-ID`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `OAuth2 requires the 'msal' package` | Run `pip install msal` |
| `--auth oauth2 requires --client-id` | Pass `--client-id <your-azure-app-id>` |
| `XOAUTH2 login failed: … InvalidClientId` | The `--client-id` is wrong or the app wasn't registered correctly |
| `XOAUTH2 login failed: … AADSTS65001` | Admin consent not granted — ask IT admin to approve the IMAP permission |
| `XOAUTH2 login failed: … AADSTS700016` | App not found in tenant — use `--tenant <your-tenant-id>` instead of `common` |
| `XOAUTH2 login failed: … AADSTS50058` | Silent sign-in not possible — delete `imap_sync_token_cache.json` and re-run interactively |
| `Login failed: [AUTHENTICATIONFAILED]` (basic) | Use an App Password, not your real password |
| `Connection failed` | Check `--host`; use `outlook.office365.com` for work accounts |
| Duplicate files after re-run | Normal — email-tracker deduplicates on import by `Message-ID`; extra `.eml` files are harmless |
| Token cache expires | Delete `imap_sync_token_cache.json` and re-run interactively to re-authenticate |

## Other IMAP providers

| Provider | Host | Port | Auth |
|---|---|---|---|
| Outlook.com (personal) | `imap-mail.outlook.com` | `993` | App Password |
| Office 365 / Exchange (work) | `outlook.office365.com` | `993` | OAuth2 (this guide) |
| Gmail | `imap.gmail.com` | `993` | App Password |
| iCloud | `imap.mail.me.com` | `993` | App Password |
| Yahoo | `imap.mail.yahoo.com` | `993` | App Password |
