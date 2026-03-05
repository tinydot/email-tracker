# pst_to_eml.py

Export all emails from an Outlook `.pst` archive as individual `.eml` files, ready to import into the email-tracker app.

## Requirements

- **Windows only** — uses the Outlook COM API via `pywin32`
- **Microsoft Outlook** must be installed (any modern version)
- **Python 3.7+**

Install the one dependency:

```
pip install pywin32
```

## Usage

```
python pst_to_eml.py <path-to-pst> <output-directory>
```

**Examples:**

```bash
python pst_to_eml.py "C:\Backup\archive.pst" "C:\emails-export"
python pst_to_eml.py "C:\Users\Alice\Documents\Outlook\2023.pst" "D:\export\2023"
```

The script walks every folder and sub-folder in the PST, exporting each email as a `.eml` file. The output directory tree mirrors the PST folder structure.

## How it works

For each email the script tries two strategies, in order:

1. **Native `SaveAs`** — asks Outlook to write the `.eml` directly (fast, lossless, works on most Outlook versions).
2. **MAPI fallback** — if `SaveAs` fails, the script reconstructs a valid MIME `.eml` from raw MAPI properties. This handles edge cases (older Outlook builds, corrupted items) and preserves:
   - Plain-text and HTML body
   - Inline images (`multipart/related` with `Content-ID`)
   - File attachments (`multipart/mixed`)
   - Threading headers: `Message-ID`, `In-Reply-To`, `References`

## Output

```
<output-directory>/
  Inbox/
    Re_ Project update_A1B2C3D4.eml
    FWD_ Invoice_E5F6G7H8.eml
    ...
  Sent Items/
    ...
  Archive/
    2022/
      ...
```

File names follow the pattern `<subject>_<entryid-suffix>.eml`. Characters illegal in file names are replaced with `_`. Paths longer than 250 characters are shortened to `email_<id>.eml`.

## Progress output

```
Connecting to Outlook COM …
Adding PST: C:\Backup\archive.pst
Exporting 'Personal Folders'  →  C:\emails-export

  Folder: Inbox (342 items)
   342 saved  →  C:\emails-export\Inbox
  Folder: Sent Items (198 items)
   198 saved  →  C:\emails-export\Sent Items
  ...

──────────────────────────────────────────────────
Done — 1043 email(s) exported.
Drop  'C:\emails-export'  into the email-tracker import panel.
```

## Importing into email-tracker

Once the export is complete, open `index.html` in your browser and use the **Import** panel to drag-and-drop the output folder. The email-tracker app will parse all `.eml` files recursively.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing dependency` error | Run `pip install pywin32` |
| `Could not open PST store` | Close Outlook (or the PST file) before running the script — a locked PST cannot be added twice |
| Emails missing attachments | The MAPI fallback reads attachments via a temporary file; ensure the script has write access to the system temp directory |
| Script hangs | Outlook may show a security prompt in the taskbar asking to allow programmatic access — click **Allow** |
| Path too long errors on Windows | Use a shorter output path, e.g. `D:\out` |

## Limitations

- Windows only (Outlook COM is not available on macOS/Linux)
- Requires a running Outlook installation — does not parse `.pst` files directly
- Calendar items, contacts, tasks, and notes are silently skipped (only `OlObjectClass.olMail` items are exported)
