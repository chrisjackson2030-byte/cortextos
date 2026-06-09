#!/bin/bash
# memory-freshness-alarm.sh — H1 (red-team 2026-06-03): the actual un-re-freeze GUARANTEE.
# An INDEPENDENT launchd job (separate from memory-maintenance) that alarms if the keep-fresh
# loop has stopped — closes the original failure mode (silent staleness, no detector). Two
# independent jobs both have to die for this to go unnoticed.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
ROOT="${CTX_FRAMEWORK_ROOT:-/Users/chrisjackson/cortextos}"
AGENT=jarvis
CHAT=7876203094
export CTX_AGENT_DIR="$ROOT/orgs/main/agents/$AGENT"
LASTF="$HOME/.cortextos/default/state/$AGENT/.memory-maint-last-success"
ALARMLOG="$HOME/.cortextos/default/logs/$AGENT/memory-freshness-alarm.log"
mkdir -p "$(dirname "$ALARMLOG")"
now=$(date -u +%s)
problem=""

if [ -f "$LASTF" ]; then
  last=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$(cat "$LASTF" 2>/dev/null)" +%s 2>/dev/null || echo 0)
  if [ "$last" -eq 0 ]; then
    problem="last-success stamp unparseable"
  else
    age=$(( (now - last) / 3600 ))
    [ "$age" -ge 8 ] && problem="memory-maintenance last success ${age}h ago (>=8h threshold)"
  fi
else
  problem="no .memory-maint-last-success (maintenance has never succeeded)"
fi

# Use the gui-domain print, NOT `launchctl list` — the latter returns an empty view when this
# script runs UNDER launchd (different bootstrap context), which caused a FALSE alarm on 2026-06-03.
if ! launchctl print "gui/$(id -u)/com.cortextos.memory-maintenance" >/dev/null 2>&1; then
  problem="${problem:+$problem; }memory-maintenance launchd job NOT loaded"
fi

# Decision-Rehearsal staleness check RETIRED 2026-06-08 (B): the act-like-B rehearsal-log has no
# active auto-write mechanism, so it perpetually re-dormants and this alarm nagged B every 2h with
# no fix. Honest retirement > forever-nag. Revive as a real decision-hook (auto-writes on each
# decision + auto-restart) when prioritized; until then, no alarm on it.

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATEF="$ROOT/orgs/main/agents/jarvis/state/.memfresh-alarm-state"

# --- AUTO-REMEDIATE known-safe class (B 2026-06-08): fix first, then notify "detected->fixed";
# escalate raw ONLY if the auto-fix fails; dedup so the same state never re-pings within 24h. ---
fixed=""
if echo "$problem" | grep -q "memory-maintenance launchd job NOT loaded"; then
  if launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cortextos.memory-maintenance.plist" 2>/dev/null \
     && launchctl print "gui/$(id -u)/com.cortextos.memory-maintenance" >/dev/null 2>&1; then
    fixed="reloaded memory-maintenance launchd job"; problem=""
  fi
fi

if [ -z "$problem" ] && [ -z "$fixed" ]; then
  echo "[$ts] OK fresh" >> "$ALARMLOG"; exit 0
fi

# DEDUP/COOLDOWN: same (fixed|problem) signature within 24h -> log only, no re-ping.
# No hashing (md5 lives in /sbin, not in launchd's PATH) — store the raw signature on line 1,
# the epoch on line 2 (2-line form avoids any delimiter collision).
sig=$(printf '%s|%s' "$fixed" "$problem" | tr '\n' ' ')
last=$(sed -n 1p "$STATEF" 2>/dev/null); lastt=$(sed -n 2p "$STATEF" 2>/dev/null)
if [ "$sig" = "$last" ] && [ -n "$lastt" ] && [ $(( now - lastt )) -lt 86400 ]; then
  echo "[$ts] (deduped <24h) fixed='$fixed' problem='$problem'" >> "$ALARMLOG"; exit 0
fi
printf '%s\n%s\n' "$sig" "$now" > "$STATEF"

if [ -n "$fixed" ] && [ -z "$problem" ]; then
  node "$ROOT/dist/cli.js" bus send-telegram "$CHAT" "⚠️ detected: memory-maintenance was unloaded → ✅ auto-fixed: $fixed. No action needed." >/dev/null 2>&1
  echo "[$ts] AUTO-FIXED: $fixed" >> "$ALARMLOG"
else
  node "$ROOT/dist/cli.js" bus send-telegram "$CHAT" "⚠️ MEMORY STALENESS — auto-fix couldn't resolve, needs you: $problem.${fixed:+ (auto-fixed: $fixed)} Won't re-ping this for 24h." >/dev/null 2>&1
  echo "[$ts] ESCALATED (deduped 24h): $problem" >> "$ALARMLOG"
fi
