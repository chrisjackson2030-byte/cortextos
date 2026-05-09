#!/usr/bin/env bash
# transcript-context.sh — retrieve context from an indexed session
# Usage: transcript-context.sh <session-id> [--turn <n>] [--window <n>] [--tool-calls] [--summary] [--json]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus session-context "$@"
