#!/usr/bin/env bash
# transcript-search.sh — full-text search across indexed session transcripts
# Usage: transcript-search.sh <query> [--agent <name>] [--thinking-only] [--tools-only] [--json] [--top-k <n>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus search-sessions "$@"
