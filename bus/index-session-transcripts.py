#!/usr/bin/env python3
"""Index session transcripts into the cortextOS knowledge base.

Extracts user messages and key assistant responses from JSONL session
transcripts, writes them as digestible markdown files, then ingests
into the KB for semantic search.

Usage: index-session-transcripts.py <agent-name> <org> [--limit N] [--force]
"""

import json
import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from hashlib import sha256

def find_transcripts(agent_name: str) -> list[Path]:
    projects_dir = Path.home() / ".claude" / "projects"
    for d in sorted(projects_dir.iterdir()):
        if d.is_dir() and agent_name in d.name:
            files = sorted(d.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
            return files
    return []

def extract_digest(transcript_path: Path) -> dict | None:
    """Extract a searchable digest from a transcript."""
    user_messages = []
    assistant_texts = []
    session_id = None
    first_ts = None
    last_ts = None
    total_lines = 0

    try:
        with open(transcript_path, "r") as f:
            for line in f:
                total_lines += 1
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ts = entry.get("timestamp")
                if ts:
                    if not first_ts:
                        first_ts = ts
                    last_ts = ts

                if not session_id and entry.get("sessionId"):
                    session_id = entry["sessionId"]

                entry_type = entry.get("type")

                if entry_type == "user":
                    msg = entry.get("message", {})
                    content = msg.get("content", "")
                    if isinstance(content, str) and len(content) > 15:
                        if not any(skip in content[:80] for skip in [
                            "CRON FIRED", "BRIEF-WINDOW", "task-notification",
                            "system-reminder", "Read HEARTBEAT", "check-approvals",
                            "loop-watchdog", "fast-pulse", "SESSION CONTINUATION"
                        ]):
                            user_messages.append(content[:400])

                elif entry_type == "assistant":
                    msg = entry.get("message", {})
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        text_parts = [b.get("text", "") for b in content if b.get("type") == "text"]
                        content = " ".join(text_parts)
                    if isinstance(content, str) and len(content) > 80:
                        assistant_texts.append(content[:400])
    except Exception as e:
        print(f"  Error reading {transcript_path.name}: {e}", file=sys.stderr)
        return None

    if not user_messages and not assistant_texts:
        return None

    return {
        "session_id": session_id or transcript_path.stem,
        "file": transcript_path.name,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "total_lines": total_lines,
        "user_messages": user_messages[:30],
        "assistant_texts": assistant_texts[:20],
    }

def digest_to_markdown(digest: dict) -> str:
    lines = [
        f"# Session Transcript Digest: {digest['session_id'][:12]}",
        f"",
        f"Period: {digest['first_ts'] or '?'} → {digest['last_ts'] or '?'}",
        f"Lines: {digest['total_lines']}",
        f"",
    ]

    if digest["user_messages"]:
        lines.append("## User Messages")
        for msg in digest["user_messages"]:
            clean = msg.replace("\n", " ")[:300]
            lines.append(f"- {clean}")
        lines.append("")

    if digest["assistant_texts"]:
        lines.append("## Key Assistant Responses")
        for txt in digest["assistant_texts"]:
            clean = txt.replace("\n", " ")[:300]
            lines.append(f"- {clean}")
        lines.append("")

    return "\n".join(lines)

def main():
    if len(sys.argv) < 3:
        print("Usage: index-session-transcripts.py <agent-name> <org> [--limit N] [--force]", file=sys.stderr)
        sys.exit(1)

    agent_name = sys.argv[1]
    org = sys.argv[2]
    limit = 20
    force = "--force" in sys.argv
    for i, arg in enumerate(sys.argv):
        if arg == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    framework_root = os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))
    digest_dir = Path(framework_root) / "orgs" / org / "agents" / agent_name / "state" / "transcript-digests"
    digest_dir.mkdir(parents=True, exist_ok=True)

    index_file = digest_dir / ".indexed"
    indexed = set()
    if index_file.exists() and not force:
        indexed = set(index_file.read_text().strip().split("\n"))

    transcripts = find_transcripts(agent_name)
    if not transcripts:
        print("No transcripts found.")
        return

    to_process = [t for t in transcripts[:limit] if t.name not in indexed]
    skip_current = transcripts[0] if transcripts else None
    to_process = [t for t in to_process if t != skip_current]

    print(f"Found {len(transcripts)} transcripts, processing {len(to_process)} (skipping current session + already indexed)")

    new_files = []
    for i, t in enumerate(to_process):
        size_mb = t.stat().st_size / (1024 * 1024)
        print(f"  [{i+1}/{len(to_process)}] {t.name} ({size_mb:.1f} MB)...", end=" ", flush=True)

        if size_mb > 300:
            print("SKIP (>300MB)")
            continue

        digest = extract_digest(t)
        if not digest:
            print("SKIP (empty)")
            indexed.add(t.name)
            continue

        md_content = digest_to_markdown(digest)
        md_path = digest_dir / f"{digest['session_id'][:12]}.md"
        md_path.write_text(md_content)
        new_files.append(md_path)
        indexed.add(t.name)
        print(f"OK ({len(digest['user_messages'])} user msgs)")

    index_file.write_text("\n".join(sorted(indexed)))

    # Digests are written for human/grep browsing. Semantic search now runs
    # LOCALLY (no Gemini/KB — that path 429'd with RESOURCE_EXHAUSTED). We index
    # the raw transcripts directly into the local SQLite vector store via
    # state/transcript-embed/embed_transcripts.py (sentence-transformers, CPU).
    # Search: bus/transcript-semantic.sh search "<query>"
    embed_py = (Path(framework_root) / "orgs" / org / "agents" / agent_name /
                "state" / "transcript-embed" / "embed_transcripts.py")
    embed_venv = (Path(framework_root) / "orgs" / org / "agents" / agent_name /
                  "state" / "embed-venv" / "bin" / "python")
    if embed_py.exists() and embed_venv.exists():
        print(f"\nUpdating local semantic index ({embed_py.name})...")
        result = subprocess.run(
            [str(embed_venv), str(embed_py), "index", "--agent", agent_name],
            capture_output=True, text=True, timeout=600
        )
        if result.returncode == 0:
            # Print the final summary line(s) from the indexer.
            tail = "\n".join(result.stdout.strip().splitlines()[-2:])
            print(f"Local index updated:\n{tail}")
        else:
            print(f"Local index error: {result.stderr.strip()}", file=sys.stderr)
    else:
        print(f"\nLocal embed module not found ({embed_py}); "
              f"wrote {len(new_files)} digests only. "
              f"Set up state/embed-venv to enable semantic search.")

if __name__ == "__main__":
    main()
