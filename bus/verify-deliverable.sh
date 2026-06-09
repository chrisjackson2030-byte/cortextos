#!/usr/bin/env bash
# verify-deliverable.sh — thin wrapper delegating to Python implementation
# The bash version used mapfile/grep -P which fail on macOS (bash 3.2, no PCRE).
# All logic lives in verify-deliverable.py.
#
# Usage: verify-deliverable.sh --task <id> | --file <path> | --stdin [options]
# Exit codes: 0=all pass, 1=any fail, 2=no citations, 3=parse error

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "${SCRIPT_DIR}/verify-deliverable.py" "$@"
