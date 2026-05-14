#!/usr/bin/env bash
# archive-shared-logs.sh — Trim large shared memory files, archiving old entries
# Usage: archive-shared-logs.sh [--dry-run] [--max-lines N]
# Designed to run as a daily cron. Keeps the last N lines of each file,
# moving older lines to a dated archive file alongside the original.
set -euo pipefail

DRY_RUN=false
MAX_LINES=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --max-lines) MAX_LINES="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ORG="${CTX_ORG:-main}"
SHARED_DIR="${FRAMEWORK_ROOT}/orgs/${ORG}/memory/shared"

FILES=(
  "reasoning-log.md"
  "reel-ideas-by-source.md"
  "deferred-items.md"
  "idea-inbox.md"
  "observation-journal.md"
  "rehearsal-log.md"
  "confidence-calibration-log.md"
)

TODAY=$(date -u +%Y-%m-%d)
ARCHIVED=0

for fname in "${FILES[@]}"; do
  fpath="${SHARED_DIR}/${fname}"
  [[ -f "$fpath" ]] || continue

  total=$(wc -l < "$fpath")
  if [[ $total -le $MAX_LINES ]]; then
    continue
  fi

  trim_count=$((total - MAX_LINES))
  base="${fname%.md}"
  archive="${SHARED_DIR}/archive/${base}-${TODAY}.md"

  if $DRY_RUN; then
    echo "[dry-run] ${fname}: ${total} lines → trim ${trim_count}, keep ${MAX_LINES}"
  else
    mkdir -p "${SHARED_DIR}/archive"
    head -n "$trim_count" "$fpath" >> "$archive"
    tail -n "$MAX_LINES" "$fpath" > "${fpath}.tmp"
    mv "${fpath}.tmp" "$fpath"
    echo "Archived ${trim_count} lines from ${fname} → archive/${base}-${TODAY}.md (kept ${MAX_LINES})"
    ARCHIVED=$((ARCHIVED + 1))
  fi
done

if $DRY_RUN; then
  echo "[dry-run] Would archive from ${ARCHIVED} file(s)"
else
  if [[ $ARCHIVED -gt 0 ]]; then
    echo "Done. Archived ${ARCHIVED} file(s)."
  else
    echo "All files within ${MAX_LINES}-line limit. Nothing to archive."
  fi
fi
