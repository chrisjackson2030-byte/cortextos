#!/usr/bin/env bash
# cortextOS daily backup — 03:00 UTC
# Scope: ~/.cortextos/ state+DBs, orgs/main memory, research, goals, agent memory files
# Retention: 7 days in ~/cortext-snapshots/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="$HOME/cortext-snapshots"
TIMESTAMP="$(date -u +%Y-%m-%d-%H%M)"
SNAPSHOT_NAME="${TIMESTAMP}-daily.tgz"
SNAPSHOT_PATH="${SNAPSHOT_DIR}/${SNAPSHOT_NAME}"
LOG_PREFIX="[backup-daily]"

echo "$LOG_PREFIX Starting cortextOS daily backup — $TIMESTAMP UTC"

# Ensure snapshot directory exists
mkdir -p "$SNAPSHOT_DIR"

# Collect paths to back up (files/dirs that exist only)
BACKUP_PATHS=()

add_if_exists() {
  for p in "$@"; do
    # Expand glob safely
    for expanded in $p; do
      if [ -e "$expanded" ]; then
        BACKUP_PATHS+=("$expanded")
      fi
    done
  done
}

# ~/.cortextos/ — state, SQLite DBs, memory, config (exclude logs and session JSONL)
add_if_exists "$HOME/.cortextos/default/state"
add_if_exists "$HOME/.cortextos/default/memory"
add_if_exists "$HOME/.cortextos/default/config"
add_if_exists "$HOME/.cortextos/default/dashboard"    # SQLite DBs live here
add_if_exists "$HOME/.cortextos/default/indexer"      # sessions.db
add_if_exists "$HOME/.cortextos/default/analytics"
add_if_exists "$HOME/.cortextos/default/outbox"
add_if_exists "$HOME/.cortextos/default/inbox"
add_if_exists "$HOME/.cortextos/default/orgs"

# cortextos repo: org-level memory, research, goals
add_if_exists "$REPO_ROOT/orgs/main/memory"
add_if_exists "$REPO_ROOT/orgs/main/research"
add_if_exists "$REPO_ROOT/orgs/main/goals.json"
add_if_exists "$REPO_ROOT/orgs/main/context.json"
add_if_exists "$REPO_ROOT/orgs/main/knowledge.md"

# Per-agent memory, goals, MEMORY.md from repo
for agent_dir in "$REPO_ROOT"/orgs/main/agents/*/; do
  [ -d "$agent_dir" ] || continue
  add_if_exists "${agent_dir}memory"
  add_if_exists "${agent_dir}MEMORY.md"
  add_if_exists "${agent_dir}goals.json"
  add_if_exists "${agent_dir}GOALS.md"
  add_if_exists "${agent_dir}IDENTITY.md"
done

# cortextos claude project memory (shared memory across agents)
add_if_exists "$HOME/.claude/projects/-Users-chrisjackson-cortextos/memory"

if [ ${#BACKUP_PATHS[@]} -eq 0 ]; then
  echo "$LOG_PREFIX ERROR: no backup paths found — aborting"
  exit 1
fi

echo "$LOG_PREFIX Snapshotting ${#BACKUP_PATHS[@]} paths → $SNAPSHOT_PATH"

# Create snapshot — paths relative to home for portability
tar -czf "$SNAPSHOT_PATH" \
  --exclude="*.log" \
  --exclude="node_modules" \
  --exclude=".git" \
  -C "$HOME" \
  $(printf '%s\n' "${BACKUP_PATHS[@]}" | sed "s|$HOME/||g" | sort -u) \
  2>/dev/null || {
    # Retry without strict -e if some paths vanished during tar
    tar -czf "$SNAPSHOT_PATH" \
      --exclude="*.log" \
      --exclude="node_modules" \
      --exclude=".git" \
      --ignore-failed-read \
      -C "$HOME" \
      $(printf '%s\n' "${BACKUP_PATHS[@]}" | sed "s|$HOME/||g" | sort -u) \
      2>/dev/null
  }

SNAPSHOT_SIZE=$(du -sh "$SNAPSHOT_PATH" 2>/dev/null | cut -f1)
echo "$LOG_PREFIX Snapshot created: $SNAPSHOT_NAME ($SNAPSHOT_SIZE)"

# 7-day retention — delete snapshots older than 7 days
echo "$LOG_PREFIX Applying 7-day retention..."
find "$SNAPSHOT_DIR" -name "*-daily.tgz" -mtime +7 -print -delete 2>/dev/null || true
REMAINING=$(find "$SNAPSHOT_DIR" -name "*-daily.tgz" | wc -l | tr -d ' ')
echo "$LOG_PREFIX Retention applied — $REMAINING daily snapshots kept"

# Log to cortextos event bus if available
if command -v cortextos &>/dev/null; then
  cortextos bus log-event action backup_completed info \
    --meta "{\"snapshot\":\"$SNAPSHOT_NAME\",\"size\":\"$SNAPSHOT_SIZE\",\"retained\":$REMAINING,\"agent\":\"forge\"}" \
    2>/dev/null || true
fi

echo "$LOG_PREFIX Daily backup complete — $SNAPSHOT_NAME"
