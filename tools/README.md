# Email Tracker — Local AI Analysis Tool

`analyze.py` runs entirely on your laptop. It reads `.eml` files, sends each one to a local [Ollama](https://ollama.com/) instance, and writes an `insights.json` file that you then import into the web app.

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

## Usage

```bash
# Basic — analyze all EML files in a folder
python tools/analyze.py --eml-dir path/to/emails/

# Limit to 5 files (good for a quick test)
python tools/analyze.py --eml-dir path/to/emails/ --limit 5

# Custom output path
python tools/analyze.py --eml-dir path/to/emails/ --out ~/Desktop/insights.json

# Use a different model
python tools/analyze.py --eml-dir path/to/emails/ --model gemma4:4b

# All options
python tools/analyze.py --help
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--eml-dir PATH` | *(required)* | Folder of `.eml` files (searches recursively) |
| `--out PATH` | `./insights.json` | Output file |
| `--model NAME` | `gemma3:4b` | Ollama model for analysis |
| `--embed-model NAME` | `nomic-embed-text` | Ollama model for embeddings |
| `--ollama-url URL` | `http://localhost:11434` | Ollama server URL |
| `--limit N` | *(none)* | Process at most N emails (for testing) |
| `--body-limit N` | `2000` | Max body characters sent to the model |
| `--save-every N` | `5` | Write output every N emails (progress saving) |

---

## Resumable runs

If the output file already exists, the script **skips** any email IDs already present in it. This means you can safely:

- Ctrl-C mid-run and restart — only unprocessed emails are analyzed.
- Add new `.eml` files and re-run — existing results are preserved.

---

## Importing into the web app

1. Run the script and confirm `insights.json` is generated.
2. Open the web app → **Settings** → **Local AI** section.
3. Click **Import insights.json** and select the file.
4. Open any analyzed email — you'll see the **Local AI Insights** panel above the email body.

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

The `embedding` field holds 768 floats (nomic-embed-text). It is used by the web app's **Find Similar** feature.
