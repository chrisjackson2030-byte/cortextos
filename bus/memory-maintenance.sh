#!/bin/bash
# memory-maintenance.sh — scheduled keep-fresh loop for the boot index + retrieval stores.
# THE missing piece (B 2026-06-03): every past memory fix re-froze because nothing SCHEDULED it.
# Wired via launchd com.cortextos.memory-maintenance (StartInterval). Quota-tolerant: a 429 on the
# embedding backend degrades gracefully (logs partial) — it never hard-fails. Idempotent.
set -uo pipefail
export CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/Users/chrisjackson/cortextos}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
ORG=main
AGENT=jarvis
ROOT="$CTX_FRAMEWORK_ROOT"
LOG="$HOME/.cortextos/default/logs/$AGENT/memory-maintenance.log"
mkdir -p "$(dirname "$LOG")"
ts(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "[$(ts)] memory-maintenance START" >> "$LOG"

# 1) Boot index + session-context (no quota dependency — always refreshes the authoritative index)
if python3 "$ROOT/bus/generate-session-context.py" "$AGENT" "$ORG" >> "$LOG" 2>&1; then
  echo "[$(ts)] OK boot-index+session-context refreshed" >> "$LOG"
  # H1: stamp last-success ONLY when the critical (quota-free) index refresh succeeds. The
  # freshness alarm watches this file — if it goes stale, the keep-fresh loop has stopped.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.cortextos/default/state/$AGENT/.memory-maint-last-success"
else
  echo "[$(ts)] ERR boot-index refresh failed" >> "$LOG"
fi

# 2) Transcript embedder (rate-aware small batch; tolerate 429)
if python3 "$ROOT/bus/index-session-transcripts.py" "$AGENT" "$ORG" --limit 5 >> "$LOG" 2>&1; then
  echo "[$(ts)] OK transcript embed" >> "$LOG"
else
  echo "[$(ts)] WARN transcript embed partial (likely embedding quota)" >> "$LOG"
fi

# 3) KB ingest recent deliverables + daily memory (throttled; tolerate 429)
if node "$ROOT/dist/cli.js" bus kb-ingest \
    "$HOME/.openclaw/workspace/discordbot/deliverables" \
    "$ROOT/orgs/$ORG/agents/$AGENT/deliverables" \
    "$ROOT/orgs/$ORG/agents/$AGENT/memory" \
    --agent "$AGENT" --scope private --org "$ORG" >> "$LOG" 2>&1; then
  echo "[$(ts)] OK kb-ingest" >> "$LOG"
else
  echo "[$(ts)] WARN kb-ingest partial (likely embedding quota)" >> "$LOG"
fi

# 4) ONE-WAY Strategist->Jarvis memory bridge (B directive 2026-06-03 #1). Ingest the Strategist
# chat's memory into shared-main so its decisions are queryable here. READ-ONLY: we only READ the
# Strategist store and WRITE into OUR kb — never write back into the Strategist dir. Throttled;
# tolerate 429 (the boot-context surface in generate-session-context.py is the quota-free primary).
STRAT_MEM="$HOME/.claude/projects/-Users-chrisjackson-cortextos-build/memory"
if [ -d "$STRAT_MEM" ]; then
  if node "$ROOT/dist/cli.js" bus kb-ingest "$STRAT_MEM" --scope shared --org "$ORG" >> "$LOG" 2>&1; then
    echo "[$(ts)] OK strategist-bridge ingest (one-way)" >> "$LOG"
  else
    echo "[$(ts)] WARN strategist-bridge ingest partial (likely embedding quota)" >> "$LOG"
  fi
fi

echo "[$(ts)] memory-maintenance END" >> "$LOG"
