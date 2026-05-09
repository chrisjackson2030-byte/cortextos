#!/usr/bin/env bash
# transcript-sessions.sh — list indexed session transcripts
# Usage: transcript-sessions.sh [--agent <name>] [--after <iso>] [--before <iso>] [--json]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus list-sessions "$@"
