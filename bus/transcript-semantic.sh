#!/usr/bin/env bash
# transcript-semantic.sh — LOCAL semantic search over session transcripts (Layer 3 memory).
#
# Fully local: sentence-transformers (all-MiniLM-L6-v2, CPU). No cloud, no API, no
# quota. Replaces the Gemini/KB path that 429'd. Self-contained under jarvis/state.
#
# Usage:
#   transcript-semantic.sh search "<query>" [--k N] [--json]
#   transcript-semantic.sh recall "<query>" [--k N] [--json]
#   transcript-semantic.sh index  [--limit N] [--max-mb MB] [--force]
#   transcript-semantic.sh stats
set -euo pipefail

JARVIS="/Users/chrisjackson/cortextos/orgs/main/agents/jarvis"
PY="$JARVIS/state/embed-venv/bin/python"
MOD="$JARVIS/state/transcript-embed/embed_transcripts.py"

if [ ! -x "$PY" ]; then
    echo "embed venv missing at $PY" >&2
    exit 1
fi

exec "$PY" "$MOD" "$@"
