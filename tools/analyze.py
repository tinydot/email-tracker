#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════
#  analyze.py — local-AI email analysis via Ollama
#  Reads an emails-for-ai-*.json export from the web app,
#  generates structured insights + embeddings, writes
#  incremental insights.json.
#
#  Usage:
#    python tools/analyze.py --emails emails-for-ai-2026-04-13.json
#
#  Multi-GPU usage (run two ollama instances first):
#    CUDA_VISIBLE_DEVICES=0 OLLAMA_HOST=0.0.0.0:11434 ollama serve &
#    CUDA_VISIBLE_DEVICES=1 OLLAMA_HOST=0.0.0.0:11435 ollama serve &
#    python tools/analyze.py --emails export.json \
#      --ollama-urls http://localhost:11434,http://localhost:11435 \
#      --workers 2
#
#  See tools/README.md for full setup instructions.
# ═══════════════════════════════════════════════════════

import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

try:
    import ollama as ollama_client
except ImportError:
    print("ERROR: ollama not installed. Run: pip install -r tools/requirements.txt")
    sys.exit(1)

try:
    from tqdm import tqdm
except ImportError:
    print("ERROR: tqdm not installed. Run: pip install -r tools/requirements.txt")
    sys.exit(1)


EXPECTED_SCHEMA_VERSION = 1


# ── JSON schema for structured LLM output ───────────────

INSIGHT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id":       {"type": "string"},
                    "title":    {"type": "string"},
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "party":    {"type": "string"},
                    "quote":    {"type": "string"},
                },
                "required": ["id", "title", "severity", "quote"],
            },
        },
        "milestones": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type":    {"type": "string", "enum": ["added", "changed", "slipped", "met"]},
                    "name":    {"type": "string"},
                    "oldDate": {"type": "string"},
                    "newDate": {"type": "string"},
                },
                "required": ["type", "name"],
            },
        },
        "designChanges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scope":       {"type": "string"},
                    "description": {"type": "string"},
                    "reason":      {"type": "string"},
                },
                "required": ["scope", "description"],
            },
        },
        "resolutions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "refersTo":   {"type": "string"},
                    "resolvedBy": {"type": "string"},
                },
                "required": ["refersTo"],
            },
        },
        "interfaces": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "parties":   {"type": "array", "items": {"type": "string"}},
                    "topic":     {"type": "string"},
                    "direction": {"type": "string"},
                },
                "required": ["parties", "topic"],
            },
        },
    },
    "required": ["summary", "issues", "milestones", "designChanges", "resolutions", "interfaces"],
}

SYSTEM_PROMPT = (
    "You analyze project/construction emails between multiple parties. "
    "Extract concrete, evidence-backed items only. For every `issues` entry, "
    "include the exact supporting `quote` from the email (≤30 words). If a "
    "category has nothing, return an empty array — never invent items. All "
    "arrays may be empty. `summary` is one sentence, ≤25 words."
)

STRICT_JSON_REMINDER = (
    "Return ONLY valid JSON matching the schema. No prose, no markdown code fences."
)


# ── Ollama calls ─────────────────────────────────────────

def build_user_msg(email: dict, body_limit: int) -> str:
    body = (email.get("textBody") or "")[:body_limit]
    tags = ", ".join(email.get("tags") or []) or "(none)"
    return (
        f"Subject: {email.get('subject', '')}\n"
        f"From: {email.get('fromName', '')} <{email.get('fromAddr', '')}>\n"
        f"To: {', '.join(email.get('toAddrs') or [])}\n"
        f"Date: {email.get('date') or 'unknown'}\n"
        f"Tags: {tags}\n"
        f"Thread: {email.get('threadId') or '(standalone)'}\n\n"
        f"{body}"
    )


def analyze_with_llm(email: dict, model: str, ollama_url: str, body_limit: int, timeout: int) -> dict:
    """Call Ollama /api/chat with structured output. Retries up to 2× on bad JSON."""
    user_msg = build_user_msg(email, body_limit)
    client = ollama_client.Client(host=ollama_url, timeout=timeout)

    for attempt in range(3):
        sys_prompt = SYSTEM_PROMPT if attempt == 0 else SYSTEM_PROMPT + " " + STRICT_JSON_REMINDER
        try:
            resp = client.chat(
                model=model,
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user",   "content": user_msg},
                ],
                format=INSIGHT_SCHEMA,
                options={"temperature": 0.1},
            )
            parsed = json.loads(resp.message.content)
            for key in ("summary", "issues", "milestones", "designChanges", "resolutions", "interfaces"):
                if key not in parsed:
                    parsed[key] = [] if key != "summary" else ""
            return parsed
        except (json.JSONDecodeError, KeyError, AttributeError) as e:
            if attempt == 2:
                raise RuntimeError(f"LLM returned invalid JSON after 3 attempts: {e}") from e
            continue
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"Ollama chat failed after 3 attempts: {e}") from e
            continue

    raise RuntimeError("LLM analysis failed after 3 attempts")


def get_embedding(text: str, model: str, ollama_url: str, body_limit: int, timeout: int) -> list[float]:
    client = ollama_client.Client(host=ollama_url, timeout=timeout)
    resp = client.embed(model=model, input=text[:body_limit])
    if hasattr(resp, "embeddings") and resp.embeddings:
        return resp.embeddings[0]
    raise RuntimeError("Empty embedding response from Ollama")


# ── Per-email worker ─────────────────────────────────────

def _process_one(
    idx: int,
    email: dict,
    ollama_url: str,
    model: str,
    embed_model: str,
    body_limit: int,
    timeout: int,
) -> tuple[str | None, dict]:
    """Analyze one email (LLM + embedding). Returns (email_id, result_dict).
    result_dict has '_error' key on failure, otherwise full insight dict."""
    email_id = email.get("id")
    if not email_id:
        return None, {"_error": f"export entry #{idx} has no id"}

    try:
        insight = analyze_with_llm(email, model, ollama_url, body_limit, timeout)
    except Exception as e:
        return email_id, {
            "_error":     str(e),
            "analyzedAt": datetime.now(timezone.utc).isoformat(),
        }

    try:
        body_for_embed = (email.get("textBody") or "")[:body_limit]
        embedding = get_embedding(body_for_embed, embed_model, ollama_url, body_limit, timeout)
    except Exception:
        embedding = []

    return email_id, {
        "analyzedAt":    datetime.now(timezone.utc).isoformat(),
        "summary":       insight.get("summary", ""),
        "issues":        insight.get("issues", []),
        "milestones":    insight.get("milestones", []),
        "designChanges": insight.get("designChanges", []),
        "resolutions":   insight.get("resolutions", []),
        "interfaces":    insight.get("interfaces", []),
        "embedding":     embedding,
    }


# ── Pre-flight checks ────────────────────────────────────

def preflight_check(model: str, embed_model: str, url_list: list[str], timeout: int):
    """Verify all Ollama instances are reachable and both models are available. Exits on failure."""
    for ollama_url in url_list:
        client = ollama_client.Client(host=ollama_url, timeout=10)
        try:
            available = {m.model for m in client.list().models}
        except Exception as e:
            print(f"ERROR: Cannot reach Ollama at {ollama_url}: {e}", file=sys.stderr)
            print("Make sure Ollama is running (ollama serve) and the URL is correct.", file=sys.stderr)
            sys.exit(1)

        missing = []
        for name in (model, embed_model):
            if name not in available and f"{name}:latest" not in available:
                missing.append(name)

        if missing:
            print(f"ERROR: Model(s) not found locally at {ollama_url}: {', '.join(missing)}", file=sys.stderr)
            print(f"Available models: {', '.join(sorted(available)) or '(none)'}", file=sys.stderr)
            print("Pull missing models with: ollama pull <model>", file=sys.stderr)
            sys.exit(1)


# ── Insights file I/O ────────────────────────────────────

def load_existing(out_path: Path) -> dict:
    if not out_path.exists():
        return {}
    try:
        with out_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "insights" in data:
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def save_insights(out_path: Path, top: dict):
    tmp = out_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, indent=2)
    tmp.replace(out_path)


def load_email_export(path: Path) -> list[dict]:
    """Load an emails-for-ai-*.json export and return the emails array."""
    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict) or "emails" not in payload:
        raise ValueError(f"'{path}' is not a valid email export (missing 'emails')")
    schema = payload.get("schemaVersion")
    if schema != EXPECTED_SCHEMA_VERSION:
        print(
            f"WARN: export schemaVersion={schema}, expected {EXPECTED_SCHEMA_VERSION}. "
            f"Proceeding anyway — update tools/analyze.py if fields have changed."
        )
    emails = payload["emails"]
    if not isinstance(emails, list):
        raise ValueError("'emails' must be a list")
    return emails


# ── Main ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Analyze emails from a web-app export via local Ollama and write insights.json."
    )
    parser.add_argument("--emails",       required=True,
                        help="Path to emails-for-ai-*.json exported from the web app")
    parser.add_argument("--out",          default="./insights.json",
                        help="Output path (default: ./insights.json)")
    parser.add_argument("--model",        default="gemma3:4b",
                        help="Ollama model (default: gemma3:4b)")
    parser.add_argument("--embed-model",  default="nomic-embed-text",
                        help="Embedding model (default: nomic-embed-text)")
    parser.add_argument("--ollama-url",   default="http://localhost:11434",
                        help="Ollama base URL (single instance)")
    parser.add_argument("--ollama-urls",  default=None,
                        help="Comma-separated Ollama URLs for multi-GPU "
                             "(e.g. http://localhost:11434,http://localhost:11435). "
                             "Overrides --ollama-url. Workers are assigned round-robin.")
    parser.add_argument("--workers",      type=int, default=1,
                        help="Parallel worker threads (default: 1). Set to match number "
                             "of Ollama instances / GPUs for best throughput.")
    parser.add_argument("--limit",        type=int, default=None,
                        help="Max emails to process (for testing)")
    parser.add_argument("--body-limit",   type=int, default=2000,
                        help="Max body chars sent to model (default: 2000)")
    parser.add_argument("--save-every",   type=int, default=5,
                        help="Save insights.json every N completions (default: 5)")
    parser.add_argument("--timeout",      type=int, default=120,
                        help="Ollama request timeout in seconds (default: 120)")
    args = parser.parse_args()

    emails_path = Path(args.emails)
    out_path    = Path(args.out)

    if not emails_path.is_file():
        print(f"ERROR: --emails '{emails_path}' is not a file", file=sys.stderr)
        sys.exit(1)

    try:
        emails = load_email_export(emails_path)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if not emails:
        print(f"No emails found in '{emails_path}'")
        sys.exit(0)

    if args.limit:
        emails = emails[: args.limit]

    # Build URL list (--ollama-urls takes precedence over --ollama-url)
    if args.ollama_urls:
        url_list = [u.strip() for u in args.ollama_urls.split(",") if u.strip()]
    else:
        url_list = [args.ollama_url]

    workers = max(1, args.workers)

    print(
        f"Loaded {len(emails)} email(s) from {emails_path}. "
        f"Model: {args.model} | Embed: {args.embed_model} | "
        f"Workers: {workers} | Ollama: {', '.join(url_list)}"
    )

    preflight_check(args.model, args.embed_model, url_list, args.timeout)

    existing          = load_existing(out_path)
    existing_insights = existing.get("insights", {})
    embed_dim         = existing.get("embedDim", None)

    top = {
        "modelVersion": f"{args.model}@{datetime.now(timezone.utc).date().isoformat()}",
        "embedModel":   args.embed_model,
        "embedDim":     embed_dim,
        "generatedAt":  datetime.now(timezone.utc).isoformat(),
        "insights":     existing_insights,
    }

    # Separate already-cached emails from those that need processing
    to_process = [
        (idx, email) for idx, email in enumerate(emails)
        if email.get("id")
        and (
            email["id"] not in existing_insights
            or "_error" in existing_insights[email["id"]]
        )
    ]
    n_skipped  = len(emails) - len(to_process)
    n_analyzed = 0
    n_errored  = 0

    if n_skipped:
        print(f"Skipping {n_skipped} already-cached email(s).")

    save_lock = threading.Lock()

    def _maybe_save(force: bool = False):
        nonlocal n_analyzed
        if force or (n_analyzed + n_errored) % args.save_every == 0:
            top["generatedAt"] = datetime.now(timezone.utc).isoformat()
            save_insights(out_path, top)

    if workers == 1:
        # ── Sequential path (original behaviour) ──────────
        with tqdm(to_process, unit="email", ncols=90) as pbar:
            for idx, email in pbar:
                pbar.set_description((email.get("subject") or email.get("id", ""))[:40])
                url = url_list[idx % len(url_list)]
                email_id, result = _process_one(
                    idx, email, url,
                    args.model, args.embed_model,
                    args.body_limit, args.timeout,
                )
                if email_id is None:
                    tqdm.write(f"  WARN: {result.get('_error', 'unknown error')}")
                    n_errored += 1
                elif "_error" in result:
                    tqdm.write(f"  LLM ERROR {email_id}: {result['_error']}")
                    n_errored += 1
                    top["insights"][email_id] = result
                else:
                    if result["embedding"] and top["embedDim"] is None:
                        top["embedDim"] = len(result["embedding"])
                    top["insights"][email_id] = result
                    n_analyzed += 1

                pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)
                _maybe_save()

    else:
        # ── Parallel path ──────────────────────────────────
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    _process_one,
                    idx, email,
                    url_list[idx % len(url_list)],
                    args.model, args.embed_model,
                    args.body_limit, args.timeout,
                ): email
                for idx, email in to_process
            }

            with tqdm(total=len(futures), unit="email", ncols=90) as pbar:
                for future in as_completed(futures):
                    email = futures[future]
                    try:
                        email_id, result = future.result()
                    except Exception as e:
                        email_id = email.get("id")
                        tqdm.write(f"  WORKER ERROR {email_id}: {e}")
                        n_errored += 1
                        pbar.update(1)
                        pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)
                        continue

                    if email_id is None:
                        tqdm.write(f"  WARN: {result.get('_error', 'unknown error')}")
                        n_errored += 1
                    elif "_error" in result:
                        tqdm.write(f"  LLM ERROR {email_id}: {result['_error']}")
                        n_errored += 1
                        with save_lock:
                            top["insights"][email_id] = result
                    else:
                        with save_lock:
                            if result["embedding"] and top["embedDim"] is None:
                                top["embedDim"] = len(result["embedding"])
                            top["insights"][email_id] = result
                            n_analyzed += 1
                            _maybe_save()

                    pbar.update(1)
                    pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)

    _maybe_save(force=True)

    print(
        f"\nDone. Analyzed: {n_analyzed} | Skipped (cached): {n_skipped} | Errors: {n_errored}"
    )
    print(f"Output: {out_path.resolve()}")


if __name__ == "__main__":
    main()
