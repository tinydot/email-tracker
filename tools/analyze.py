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
#  See tools/README.md for full setup instructions.
# ═══════════════════════════════════════════════════════

import argparse
import json
import sys
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


def analyze_with_llm(email: dict, model: str, ollama_url: str, body_limit: int) -> dict:
    """Call Ollama /api/chat with structured output. Retries up to 2× on bad JSON."""
    user_msg = build_user_msg(email, body_limit)
    client = ollama_client.Client(host=ollama_url)

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

    raise RuntimeError("LLM analysis failed after 3 attempts")


def get_embedding(text: str, model: str, ollama_url: str, body_limit: int) -> list[float]:
    client = ollama_client.Client(host=ollama_url)
    resp = client.embed(model=model, input=text[:body_limit])
    if hasattr(resp, "embeddings") and resp.embeddings:
        return resp.embeddings[0]
    raise RuntimeError("Empty embedding response from Ollama")


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
                        help="Ollama base URL")
    parser.add_argument("--limit",        type=int, default=None,
                        help="Max emails to process (for testing)")
    parser.add_argument("--body-limit",   type=int, default=2000,
                        help="Max body chars sent to model (default: 2000)")
    parser.add_argument("--save-every",   type=int, default=5,
                        help="Save insights.json every N emails (default: 5)")
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

    print(f"Loaded {len(emails)} email(s) from {emails_path}. "
          f"Model: {args.model} | Embed: {args.embed_model}")

    existing       = load_existing(out_path)
    existing_insights = existing.get("insights", {})
    embed_dim      = existing.get("embedDim", None)

    top = {
        "modelVersion": f"{args.model}@{datetime.now(timezone.utc).date().isoformat()}",
        "embedModel":   args.embed_model,
        "embedDim":     embed_dim,
        "generatedAt":  datetime.now(timezone.utc).isoformat(),
        "insights":     existing_insights,
    }

    n_analyzed = 0
    n_skipped  = 0
    n_errored  = 0

    with tqdm(emails, unit="email", ncols=90) as pbar:
        for idx, email in enumerate(pbar):
            email_id = email.get("id")
            if not email_id:
                tqdm.write(f"  WARN: export entry #{idx} has no id — skipped")
                n_errored += 1
                continue

            pbar.set_description((email.get("subject") or email_id)[:40])

            if email_id in existing_insights and "_error" not in existing_insights[email_id]:
                n_skipped += 1
                pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)
                continue

            try:
                insight = analyze_with_llm(email, args.model, args.ollama_url, args.body_limit)
            except Exception as e:
                tqdm.write(f"  LLM ERROR {email_id}: {e}")
                n_errored += 1
                top["insights"][email_id] = {
                    "_error":     str(e),
                    "analyzedAt": datetime.now(timezone.utc).isoformat(),
                }
                continue

            try:
                body_for_embed = (email.get("textBody") or "")[: args.body_limit]
                embedding = get_embedding(body_for_embed, args.embed_model, args.ollama_url, args.body_limit)
                if embed_dim is None and embedding:
                    embed_dim = len(embedding)
                    top["embedDim"] = embed_dim
            except Exception as e:
                tqdm.write(f"  EMBED ERROR {email_id}: {e}")
                embedding = []

            top["insights"][email_id] = {
                "analyzedAt":    datetime.now(timezone.utc).isoformat(),
                "summary":       insight.get("summary", ""),
                "issues":        insight.get("issues", []),
                "milestones":    insight.get("milestones", []),
                "designChanges": insight.get("designChanges", []),
                "resolutions":   insight.get("resolutions", []),
                "interfaces":    insight.get("interfaces", []),
                "embedding":     embedding,
            }

            n_analyzed += 1
            pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)

            if (idx + 1) % args.save_every == 0:
                top["generatedAt"] = datetime.now(timezone.utc).isoformat()
                save_insights(out_path, top)

    top["generatedAt"] = datetime.now(timezone.utc).isoformat()
    save_insights(out_path, top)

    print(
        f"\nDone. Analyzed: {n_analyzed} | Skipped (cached): {n_skipped} | Errors: {n_errored}"
    )
    print(f"Output: {out_path.resolve()}")


if __name__ == "__main__":
    main()
