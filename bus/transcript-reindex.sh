#!/usr/bin/env bash
# transcript-reindex.sh — force full reindex of session transcripts
# Usage: transcript-reindex.sh [--agent <name>] [--session <uuid>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus index-sessions --force "$@"
