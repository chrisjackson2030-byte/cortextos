#!/bin/bash
# search-transcripts.sh — grep-based transcript search (Layer 3 fallback)
# Searches extracted session digests for keywords. Returns matching files + context.
# Works without any API/embedding quota. Complements the KB semantic search.
#
# Usage: search-transcripts.sh <query> [agent] [org]

set -euo pipefail

QUERY="${1:-}"
AGENT="${2:-jarvis}"
ORG="${3:-main}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
DIGEST_DIR="$FRAMEWORK_ROOT/orgs/$ORG/agents/$AGENT/state/transcript-digests"

if [ -z "$QUERY" ]; then
    echo "Usage: search-transcripts.sh <query> [agent] [org]"
    echo "Searches session transcript digests for keywords."
    exit 1
fi

if [ ! -d "$DIGEST_DIR" ]; then
    echo "No transcript digests found at $DIGEST_DIR"
    echo "Run: python3 bus/index-session-transcripts.py $AGENT $ORG"
    exit 1
fi

DIGEST_COUNT=$(ls "$DIGEST_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Searching $DIGEST_COUNT session digests for: $QUERY"
echo "---"

grep -rli "$QUERY" "$DIGEST_DIR"/*.md 2>/dev/null | while read -r file; do
    SESSION=$(basename "$file" .md)
    PERIOD=$(grep "^Period:" "$file" 2>/dev/null | head -1)
    echo ""
    echo "=== Session $SESSION ==="
    echo "  $PERIOD"
    grep -n -i -C1 "$QUERY" "$file" | head -10
done

HITS=$(grep -rli "$QUERY" "$DIGEST_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "--- $HITS session(s) matched ---"
