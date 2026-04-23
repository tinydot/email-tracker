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
   ollama pull gemma4:4b          # ~3 GB — primary analysis model
   ollama pull nomic-embed-text   # ~270 MB — embeddings
   ```

   > If your Ollama version doesn't yet have `gemma4:4b`, fall back to
   > `gemma3:4b` (pass it via `--model gemma3:4b`).

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
python tools/analyze.py --emails emails-for-ai-2026-04-13.json --model gemma3:4b

# Parallel workers (single GPU, multiple concurrent requests)
python tools/analyze.py --emails emails-for-ai-2026-04-13.json --workers 4

# Multi-GPU with high concurrency (see section below for setup)
python tools/analyze.py --emails emails-for-ai-2026-04-13.json \
  --ollama-urls http://localhost:11434,http://localhost:11435 \
  --workers 16

# All options
python tools/analyze.py --help
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--emails PATH` | *(required)* | Path to `emails-for-ai-*.json` from the web app |
| `--out PATH` | `./insights.json` | Output file |
| `--model NAME` | `gemma4:4b` | Ollama model for analysis |
| `--embed-model NAME` | `nomic-embed-text` | Ollama model for embeddings |
| `--ollama-url URL` | `http://localhost:11434` | Ollama server URL (single instance) |
| `--ollama-urls URLs` | *(none)* | Comma-separated URLs for multi-GPU; overrides `--ollama-url` |
| `--workers N` | `1` | Parallel worker threads; set to match number of GPUs/instances |
| `--limit N` | *(none)* | Process at most N emails (for testing) |
| `--body-limit N` | `2000` | Max body characters sent to the model |
| `--save-every N` | `5` | Write output every N completions (progress saving) |

---

## Multi-GPU setup

Running one Ollama instance per GPU lets the script spread work across both
cards. For maximum throughput, also raise each instance's parallel-request
slots so a single GPU processes several emails at once — small models like
`gemma4:4b` leave plenty of spare VRAM for extra KV caches.

**Step 1 — Start one Ollama instance per GPU with parallel slots enabled.**

Open two terminal windows and run one command in each:

```bash
# Terminal 1 — GPU 0
CUDA_VISIBLE_DEVICES=0 OLLAMA_NUM_PARALLEL=8 OLLAMA_KEEP_ALIVE=24h \
  OLLAMA_HOST=0.0.0.0:11434 ollama serve

# Terminal 2 — GPU 1
CUDA_VISIBLE_DEVICES=1 OLLAMA_NUM_PARALLEL=8 OLLAMA_KEEP_ALIVE=24h \
  OLLAMA_HOST=0.0.0.0:11435 ollama serve
```

Or run both in the background from a single terminal:

```bash
CUDA_VISIBLE_DEVICES=0 OLLAMA_NUM_PARALLEL=8 OLLAMA_KEEP_ALIVE=24h OLLAMA_HOST=0.0.0.0:11434 ollama serve &
CUDA_VISIBLE_DEVICES=1 OLLAMA_NUM_PARALLEL=8 OLLAMA_KEEP_ALIVE=24h OLLAMA_HOST=0.0.0.0:11435 ollama serve &
```

- `OLLAMA_NUM_PARALLEL=8` lets each server handle 8 concurrent requests.
- `OLLAMA_KEEP_ALIVE=24h` keeps the model resident so it isn't unloaded
  between batches.

**Step 2 — Pull models on both instances.**

```bash
OLLAMA_HOST=localhost:11434 ollama pull gemma4:4b
OLLAMA_HOST=localhost:11435 ollama pull gemma4:4b
OLLAMA_HOST=localhost:11434 ollama pull nomic-embed-text
OLLAMA_HOST=localhost:11435 ollama pull nomic-embed-text
```

PowerShell equivalent:

```powershell
$env:OLLAMA_HOST="localhost:11434"; ollama pull gemma4:4b
```

**Step 3 — Run the script with matching client-side workers.**

Set `--workers` to roughly `2 × OLLAMA_NUM_PARALLEL` so both GPUs stay fully
fed:

```bash
python tools/analyze.py --emails emails-for-ai-2026-04-13.json \
  --ollama-urls http://localhost:11434,http://localhost:11435 \
  --workers 16
```

Workers are distributed across the URLs round-robin. The script's preflight
check verifies both instances are reachable and have the required models before
starting.

**Tuning guidance.** Start at `--workers 8` (4 per GPU) and watch `nvidia-smi`:

- GPU utilisation well under 100% and VRAM not full → raise `--workers`
  (try 12, then 16).
- Request timeouts or VRAM near the limit → lower `OLLAMA_NUM_PARALLEL`
  and `--workers` in step.

**Reference sizing — dual NVIDIA RTX 4500 Ada (24 GB each) with `gemma4:4b`:**
`OLLAMA_NUM_PARALLEL=8` per server and `--workers 16` is a safe high-throughput
starting point. The 4B model weights occupy ~3 GB, leaving ~18 GB per card for
KV cache across 8 parallel slots.

> **Verify your GPUs are visible first:**
> ```bash
> nvidia-smi
> ```
> You should see both GPUs listed (GPU 0 and GPU 1).

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

| Setup | Per email | 100 emails |
|---|---|---|
| CPU only | ~2–5 s | ~4–8 min |
| Single GPU (8 GB VRAM) | ~0.5–1.5 s | ~1–3 min |
| Two GPUs, `--workers 2` (one request per GPU) | ~0.3–0.8 s | ~0.5–1.5 min |
| Two GPUs, `OLLAMA_NUM_PARALLEL=8` + `--workers 16` | ~0.1–0.3 s | ~10–30 s |

Times are for `gemma4:4b`. Larger models are proportionally slower. Raising
`OLLAMA_NUM_PARALLEL` and `--workers` together keeps both GPUs saturated,
since one request doesn't use all of a GPU's compute.

---

## Output format

```json
{
  "modelVersion": "gemma4:4b@2026-04-13",
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
