#!/usr/bin/env bash
# send-telegram.sh — wrapper for Node.js CLI
# Usage: send-telegram.sh <chat_id> <message> [--image /path/to/image]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

node "$CLI" bus send-telegram "$@"
EXIT_CODE=$?

# Log outbound message to agent's telegram-outbox.jsonl (rolling 200 entries)
if [ $EXIT_CODE -eq 0 ] && [ -n "${CTX_AGENT_NAME:-}" ]; then
  _LOG_DIR="${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG:-main}/agents/${CTX_AGENT_NAME}/state"
  _LOG_FILE="${_LOG_DIR}/telegram-outbox.jsonl"
  mkdir -p "$_LOG_DIR" 2>/dev/null || true
  _TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  _MSG_JSON=$(python3 -c 'import sys,json; print(json.dumps(sys.argv[1]))' "${2:-}" 2>/dev/null || echo '"(log error)"')
  echo "{\"ts\":\"$_TS\",\"to\":\"${1:-}\",\"text\":$_MSG_JSON}" >> "$_LOG_FILE" 2>/dev/null || true
  _LC=$(wc -l < "$_LOG_FILE" 2>/dev/null || echo 0)
  if [ "$_LC" -gt 200 ]; then
    tail -n 200 "$_LOG_FILE" > "$_LOG_FILE.tmp" && mv "$_LOG_FILE.tmp" "$_LOG_FILE" 2>/dev/null || true
  fi
fi

exit $EXIT_CODE
