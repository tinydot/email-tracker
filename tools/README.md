# Email Tracker — Local AI Analysis Tool

`analyze.py` runs entirely on your laptop. It reads an email export produced by the
web app, sends each email to a local [Ollama](https://ollama.com/) instance, and
writes an `insights.json` file that you then import back into the web app.

Sourcing from the web app's export (rather than raw `.eml` files) means the
script uses the exact same `textBody` you see in the UI — signatures already
truncated, quotes stripped — and automatically skips anything flagged as a
system or low-value email.

No data leaves your machine. No CORS issues. No API keys.

---

## Prerequisites

1. **Python 3.11+**
2. **Ollama** — install from [ollama.com](https://ollama.com/), then pull the models:

   ```bash
   ollama pull gemma3:4b          # ~3 GB — primary analysis model
   ollama pull nomic-embed-text   # ~270 MB — embeddings
   ```

   > **Gemma 4 4B** (`gemma4:4b`) is preferred if your Ollama version supports it.
   > Fall back to `gemma3:4b` if the pull fails.

3. **Python dependencies:**

   ```bash
   pip install -r tools/requirements.txt
   ```

---

## Workflow

```
Web app                                        Laptop (terminal)            Web app
─────────                                      ─────────────────            ─────────
Filter to the emails you want analyzed         analyze.py --emails …        Settings → Local AI
Settings → Local AI → Export current view ──►  insights.json is produced ──► Import insights.json
```

1. In the web app, narrow the email list to the scope you want analyzed (a
   smart view, an unread view, a date filter, etc.).
2. Open **Settings → Local AI** and click **Export current view for AI**. This
   downloads `emails-for-ai-YYYY-MM-DD.json` — only the current view, with
   system/low-value emails already excluded.
3. Run the script:

   ```bash
   python tools/analyze.py --emails ~/Downloads/emails-for-ai-2026-04-13.json
   ```

4. Back in the web app, click **Import insights.json**.
5. Open any analyzed email — the **Local AI Insights** panel appears above the
   body.

---

## Usage

```bash
# Basic
python tools/analyze.py --emails emails-for-ai-2026-04-13.json

# Limit to 5 emails (good for a quick test)
python tools/analyze.py --emails emails-for-ai-2026-04-13.json --limit 5

# Custom output path
python tools/analyze.py --emails emails-for-ai-2026-04-13.json --out ~/Desktop/insights.json

# Use a different model
python tools/analyze.py --emails emails-for-ai-2026-04-13.json --model gemma4:4b

# All options
python tools/analyze.py --help
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--emails PATH` | *(required)* | Path to `emails-for-ai-*.json` from the web app |
| `--out PATH` | `./insights.json` | Output file |
| `--model NAME` | `gemma3:4b` | Ollama model for analysis |
| `--embed-model NAME` | `nomic-embed-text` | Ollama model for embeddings |
| `--ollama-url URL` | `http://localhost:11434` | Ollama server URL |
| `--limit N` | *(none)* | Process at most N emails (for testing) |
| `--body-limit N` | `2000` | Max body characters sent to the model |
| `--save-every N` | `5` | Write output every N emails (progress saving) |

---

## Resumable runs

If the output file already exists, the script **skips** any email IDs already
present in it (unless the previous entry recorded an `_error`, in which case
it retries). This means you can safely:

- Ctrl-C mid-run and restart — only unprocessed emails are analyzed.
- Re-export a bigger view and re-run — existing results are preserved.

---

## Expected runtime

On a modest laptop (CPU only, no GPU):

| Model | Per email | 100 emails |
|---|---|---|
| gemma3:4b | ~2–5 s | ~4–8 min |
| gemma4:4b | ~3–7 s | ~5–12 min |

With a small GPU (e.g. 8 GB VRAM): roughly 3–5× faster.

---

## Output format

```json
{
  "modelVersion": "gemma3:4b@2026-04-13",
  "embedModel":   "nomic-embed-text",
  "embedDim":     768,
  "generatedAt":  "2026-04-13T...",
  "insights": {
    "<emailId>": {
      "analyzedAt":    "...",
      "summary":       "One sentence description.",
      "issues":        [{"id": "i1", "title": "...", "severity": "high", "quote": "..."}],
      "milestones":    [],
      "designChanges": [],
      "resolutions":   [],
      "interfaces":    [],
      "embedding":     [0.012, -0.043, ...]
    }
  }
}
```

The `embedding` field holds 768 floats (nomic-embed-text). It is used by the
web app's **Find Similar** feature.
