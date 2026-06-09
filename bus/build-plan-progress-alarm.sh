#!/bin/bash
# Build-plan progress alarm (Strategist audit 2026-06-08): the Jarvis-completion build-plan stalled
# at gate M for ~5 days and NOTHING fired. This closes that gap: if loop-state.json's
# last_advanced_at is older than the threshold, ping B ONCE (deduped) — the PRIMARY objective
# (Jarvis-complete) must never silently lose to the daily asks again.
set -uo pipefail
export PATH="/usr/bin:/bin:/sbin:/usr/sbin:/opt/homebrew/bin:$PATH"
ROOT=/Users/chrisjackson/cortextos
LOOP="$ROOT/orgs/main/agents/jarvis/state/loop-state.json"
STATEF="$ROOT/orgs/main/agents/jarvis/state/.buildplan-alarm-state"
CHAT="7876203094"
THRESHOLD_H="${1:-48}"   # hours; arg override for testing
now=$(date +%s)

[ -f "$LOOP" ] || exit 0
# last_advanced_at + current gate from loop-state (epoch via python, robust)
read -r last_epoch gate <<<"$(/Users/chrisjackson/cortextos-data/warehouse/.venv/bin/python - "$LOOP" <<'PY'
import json,sys,datetime as dt
d=json.load(open(sys.argv[1]))
la=d.get('last_advanced_at','')
try:
    e=int(dt.datetime.fromisoformat(la.replace('Z','+00:00')).timestamp())
except Exception:
    e=0
print(e, d.get('current_iteration','?'))
PY
)"
[ "${last_epoch:-0}" -gt 0 ] || exit 0
age_h=$(( (now - last_epoch) / 3600 ))
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$age_h" -lt "$THRESHOLD_H" ]; then
  echo "[$ts] OK build-plan advanced ${age_h}h ago (gate $gate)" >> "$STATEF.log" 2>/dev/null
  exit 0
fi
# DEDUP: don't re-ping the same stale-gate within 24h
sig="stall|$gate|$last_epoch"
last_sig=$(sed -n 1p "$STATEF" 2>/dev/null); last_t=$(sed -n 2p "$STATEF" 2>/dev/null)
if [ "$sig" = "$last_sig" ] && [ -n "$last_t" ] && [ $(( now - last_t )) -lt 86400 ]; then
  exit 0
fi
printf '%s\n%s\n' "$sig" "$now" > "$STATEF"
node "$ROOT/dist/cli.js" bus send-telegram "$CHAT" "⚠️ BUILD-PLAN STALL: the Jarvis-completion plan hasn't advanced a gate in ${age_h}h (stuck at gate ${gate}). The PRIMARY objective is losing to the daily asks — reserve build-plan capacity + move the next gate. (Won't re-ping this for 24h.)" >/dev/null 2>&1
echo "[$ts] ALARM build-plan stalled ${age_h}h at gate $gate" >> "$STATEF.log" 2>/dev/null
