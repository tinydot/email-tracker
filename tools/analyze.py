#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════
#  analyze.py — local-AI email analysis via Ollama
#  Reads .eml files, generates structured insights +
#  embeddings, writes incremental insights.json.
#
#  Usage:
#    python tools/analyze.py --eml-dir ./emails --out insights.json
#
#  See tools/README.md for full setup instructions.
# ═══════════════════════════════════════════════════════

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import mailparser
except ImportError:
    print("ERROR: mail-parser not installed. Run: pip install -r tools/requirements.txt")
    sys.exit(1)

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


# ── emailId computation — mirrors js/import.js line 333 ─

def clean_msg_id(raw: str) -> str:
    """Mirror js/parser.js cleanMsgId: extract content from <...> or trim."""
    m = re.search(r"<([^>]+)>", raw)
    return m.group(1) if m else raw.strip()


def parse_date_iso(raw: str) -> str | None:
    """Mirror js/parser.js parseDate: parse RFC 2822 date → ISO 8601 string."""
    if not raw:
        return None
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(raw)
        return dt.isoformat()
    except Exception:
        pass
    # Fallback: let Python's general parser try
    try:
        from dateutil.parser import parse as dateutil_parse
        return dateutil_parse(raw).isoformat()
    except Exception:
        pass
    return None


def compute_email_id(filename: str, message_id_raw: str | None, date_raw: str | None) -> str:
    """
    Mirror js/import.js:333 exactly:
      id = parsed.messageId || `${file.name}-${parsed.date || Date.now()}`

    parsed.messageId = cleanMsgId(headers['message-id']) if truthy
    parsed.date      = parseDate(headers['date'])         → ISO string or null
    file.name        = the bare filename (e.g. 'email.eml')
    Date.now()       is epoch ms as integer string
    """
    if message_id_raw:
        msg_id = clean_msg_id(message_id_raw)
        if msg_id:
            return msg_id

    date_iso = parse_date_iso(date_raw) if date_raw else None
    if date_iso:
        return f"{filename}-{date_iso}"
    # Last resort: use current epoch ms — deterministic only if date is present;
    # Without a date the JS also falls back to Date.now() which is non-deterministic.
    # We flag this in a warning so the user knows.
    return None  # Caller must handle


# ── EML parsing ─────────────────────────────────────────

def parse_eml(path: Path) -> dict:
    """Parse an EML file; return a dict of fields matching the email record."""
    raw = path.read_bytes()
    mp = mailparser.parse_from_bytes(raw)

    # Raw headers for Message-ID and Date
    msg_id_raw = mp.message_id or ""
    date_raw   = mp.date_str or ""

    # Compute ID
    email_id = compute_email_id(path.name, msg_id_raw, date_raw)

    # Body: prefer plain text
    text_body = mp.body or ""
    if not text_body and mp.text_html:
        import html
        text_body = re.sub(r"<[^>]+>", " ", "\n".join(mp.text_html))
        text_body = html.unescape(text_body)

    # Addresses
    def extract_addrs(lst):
        return [a[1] for a in lst if a[1]] if lst else []

    return {
        "emailId":   email_id,
        "fileName":  path.name,
        "dateRaw":   date_raw,
        "msgIdRaw":  msg_id_raw,
        "subject":   mp.subject or "(no subject)",
        "fromAddr":  mp.from_[0][1] if mp.from_ else "",
        "fromName":  mp.from_[0][0] if mp.from_ else "",
        "toAddrs":   extract_addrs(mp.to),
        "ccAddrs":   extract_addrs(mp.cc),
        "date":      parse_date_iso(date_raw),
        "textBody":  text_body,
    }


# ── Ollama calls ─────────────────────────────────────────

def analyze_with_llm(
    email: dict,
    model: str,
    ollama_url: str,
    body_limit: int,
) -> dict:
    """
    Call Ollama /api/chat with structured output.
    Returns a parsed dict matching INSIGHT_SCHEMA.
    Retries up to 2 times on bad JSON.
    """
    body = (email.get("textBody") or "")[:body_limit]

    user_msg = (
        f"Subject: {email['subject']}\n"
        f"From: {email['fromName']} <{email['fromAddr']}>\n"
        f"To: {', '.join(email['toAddrs'])}\n"
        f"Date: {email.get('date') or email.get('dateRaw') or 'unknown'}\n\n"
        f"{body}"
    )

    client = ollama_client.Client(host=ollama_url)

    for attempt in range(3):
        sys_prompt = SYSTEM_PROMPT
        if attempt > 0:
            sys_prompt = SYSTEM_PROMPT + " " + STRICT_JSON_REMINDER

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
            content = resp.message.content
            parsed = json.loads(content)
            # Validate required top-level keys
            for key in ("summary", "issues", "milestones", "designChanges", "resolutions", "interfaces"):
                if key not in parsed:
                    parsed[key] = [] if key != "summary" else ""
            return parsed
        except (json.JSONDecodeError, KeyError, AttributeError) as e:
            if attempt == 2:
                raise RuntimeError(f"LLM returned invalid JSON after 3 attempts: {e}") from e
            continue

    raise RuntimeError("LLM analysis failed after 3 attempts")


def get_embedding(
    text: str,
    model: str,
    ollama_url: str,
    body_limit: int,
) -> list[float]:
    """Call Ollama /api/embed for a single text, return list of floats."""
    client = ollama_client.Client(host=ollama_url)
    truncated = text[:body_limit]
    resp = client.embed(model=model, input=truncated)
    # ollama Python client returns resp.embeddings as list-of-list
    if hasattr(resp, "embeddings") and resp.embeddings:
        return resp.embeddings[0]
    raise RuntimeError("Empty embedding response from Ollama")


# ── Insights file I/O ────────────────────────────────────

def load_existing(out_path: Path) -> dict:
    """Load existing insights.json if present; returns the top-level dict."""
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
    """Write insights.json atomically (write-then-rename)."""
    tmp = out_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, indent=2)
    tmp.replace(out_path)


# ── Main ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Analyze .eml files via local Ollama and write insights.json."
    )
    parser.add_argument("--eml-dir",      required=True, help="Directory of .eml files (recursive)")
    parser.add_argument("--out",          default="./insights.json", help="Output path (default: ./insights.json)")
    parser.add_argument("--model",        default="gemma3:4b",        help="Ollama model (default: gemma3:4b)")
    parser.add_argument("--embed-model",  default="nomic-embed-text", help="Embedding model (default: nomic-embed-text)")
    parser.add_argument("--ollama-url",   default="http://localhost:11434", help="Ollama base URL")
    parser.add_argument("--limit",        type=int, default=None, help="Max emails to process (for testing)")
    parser.add_argument("--body-limit",   type=int, default=2000, help="Max body chars sent to model (default: 2000)")
    parser.add_argument("--save-every",   type=int, default=5,    help="Save insights.json every N emails (default: 5)")
    args = parser.parse_args()

    eml_dir  = Path(args.eml_dir)
    out_path = Path(args.out)

    if not eml_dir.is_dir():
        print(f"ERROR: --eml-dir '{eml_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    # Find EML files recursively
    eml_files = sorted(eml_dir.rglob("*.eml"))
    if not eml_files:
        print(f"No .eml files found in '{eml_dir}'")
        sys.exit(0)

    if args.limit:
        eml_files = eml_files[: args.limit]

    print(f"Found {len(eml_files)} .eml file(s). Model: {args.model} | Embed: {args.embed_model}")

    # Load existing insights (for resumability)
    existing = load_existing(out_path)
    existing_insights = existing.get("insights", {})

    # Detect embed dim from existing data
    embed_dim = existing.get("embedDim", None)

    # Build top-level metadata (will be updated at end)
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
    errors     = {}

    # Progress bar
    with tqdm(eml_files, unit="email", ncols=90) as pbar:
        for idx, eml_path in enumerate(pbar):
            pbar.set_description(eml_path.name[:40])

            # Parse EML
            try:
                email = parse_eml(eml_path)
            except Exception as e:
                tqdm.write(f"  PARSE ERROR {eml_path.name}: {e}")
                n_errored += 1
                continue

            email_id = email.get("emailId")
            if not email_id:
                tqdm.write(
                    f"  WARN: cannot compute stable ID for {eml_path.name} "
                    f"(no Message-ID and no parseable Date) — skipped"
                )
                n_errored += 1
                continue

            # Skip if already analyzed
            if email_id in existing_insights:
                n_skipped += 1
                pbar.set_postfix(skip=n_skipped, ok=n_analyzed, err=n_errored)
                continue

            # Analyze with LLM
            try:
                insight = analyze_with_llm(email, args.model, args.ollama_url, args.body_limit)
            except Exception as e:
                tqdm.write(f"  LLM ERROR {eml_path.name}: {e}")
                errors[email_id] = {"error": str(e), "file": eml_path.name}
                n_errored += 1
                top["insights"][email_id] = {"_error": str(e), "analyzedAt": datetime.now(timezone.utc).isoformat()}
                continue

            # Get embedding
            try:
                body_for_embed = (email.get("textBody") or "")[:args.body_limit]
                embedding = get_embedding(body_for_embed, args.embed_model, args.ollama_url, args.body_limit)
                if embed_dim is None and embedding:
                    embed_dim = len(embedding)
                    top["embedDim"] = embed_dim
            except Exception as e:
                tqdm.write(f"  EMBED ERROR {eml_path.name}: {e}")
                embedding = []

            # Store result
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

            # Incremental save
            if (idx + 1) % args.save_every == 0:
                top["generatedAt"] = datetime.now(timezone.utc).isoformat()
                save_insights(out_path, top)

    # Final save
    top["generatedAt"] = datetime.now(timezone.utc).isoformat()
    save_insights(out_path, top)

    print(
        f"\nDone. Analyzed: {n_analyzed} | Skipped (cached): {n_skipped} | Errors: {n_errored}"
    )
    print(f"Output: {out_path.resolve()}")


if __name__ == "__main__":
    main()
