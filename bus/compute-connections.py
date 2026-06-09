#!/usr/bin/env python3
"""compute-connections.py — find semantic links between what we're doing NOW and
things mentioned a while ago (B's "Connections" dashboard feature).

NOW  = current active work (today's daily-memory topics + in-progress decisions).
THEN = past ideas/projects in the shared registries (idea-inbox, deferred-items).
A connection = a NOW topic that is semantically close to a THEN entry — surfaced
so B sees "what we're building now ties back to X you mentioned weeks ago →
potential new idea."

Uses the LOCAL embedding index (transcript-semantic.sh) — no quota.
Writes connections.json for the dashboard to read.

Usage: compute-connections.py [agent] [org]
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

FRAMEWORK = os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))
AGENT = sys.argv[1] if len(sys.argv) > 1 else "jarvis"
ORG = sys.argv[2] if len(sys.argv) > 2 else "main"
SEARCH = Path(FRAMEWORK) / "bus" / "transcript-semantic.sh"
MEM_DIR = Path(FRAMEWORK) / "orgs" / ORG / "agents" / AGENT / "memory"
OUT = Path(FRAMEWORK) / "orgs" / ORG / "agents" / AGENT / "state" / "connections.json"

# Registry files that count as "THEN" (past ideas/projects).
REGISTRY_HINTS = ("idea-inbox", "deferred-items", "reel-ideas")


def now_topics(max_topics: int = 8) -> list[str]:
    """Pull current-work topics from the last 2 daily-memory files: lines that
    describe what we're actively doing/deciding."""
    if not MEM_DIR.exists():
        return []
    files = sorted(MEM_DIR.glob("20*-*-*.md"), reverse=True)[:2]
    topics: list[str] = []
    pat = re.compile(r"(WORKING ON|DONE|BUILT|dispatched|Current focus|Resuming|directive|decision)\s*:?\s*(.+)", re.I)
    for f in files:
        try:
            lines = f.read_text().splitlines()
        except Exception:
            continue
        for ln in lines:
            m = pat.search(ln)
            if m:
                t = re.sub(r"[*#`\-]", "", m.group(2)).strip()
                t = re.sub(r"\s+", " ", t)[:90]
                if len(t) > 15 and t not in topics:
                    topics.append(t)
            if len(topics) >= max_topics:
                break
        if len(topics) >= max_topics:
            break
    return topics[:max_topics]


def search(query: str, k: int = 3) -> list[dict]:
    """Run the local embedding search, return hits in registry files only."""
    if not SEARCH.exists():
        return []
    try:
        res = subprocess.run(
            ["bash", str(SEARCH), "search", query, "--k", str(k)],
            capture_output=True, text=True, timeout=30, cwd=FRAMEWORK,
        )
    except Exception:
        return []
    hits = []
    for ln in res.stdout.splitlines():
        s = ln.strip()
        # Lines like: "[1] score=0.51 ... /path/to/file.md ..."
        m = re.search(r"score=([0-9.]+).*?(/\S+\.md)", s)
        if m:
            path = m.group(2)
            if any(h in path for h in REGISTRY_HINTS):
                hits.append({"score": float(m.group(1)), "file": Path(path).name})
    return hits


def main():
    topics = now_topics()
    connections = []
    for t in topics:
        for h in search(t):
            if h["score"] < 0.30:  # weak link — skip
                continue
            connections.append({
                "now": t,
                "connects_to": h["file"].replace(".md", ""),
                "score": round(h["score"], 3),
            })
    # Dedup (now, connects_to), keep strongest
    best = {}
    for c in connections:
        key = (c["now"], c["connects_to"])
        if key not in best or c["score"] > best[key]["score"]:
            best[key] = c
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "connections": sorted(best.values(), key=lambda c: c["score"], reverse=True)[:12],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2))
    print(f"Wrote {len(out['connections'])} connections to {OUT}")
    for c in out["connections"][:8]:
        print(f"  {c['score']}  '{c['now'][:50]}'  →  {c['connects_to']}")


if __name__ == "__main__":
    main()
