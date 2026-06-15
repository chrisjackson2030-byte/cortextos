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
# Terminal-state detection (WS4 2026-06-15): the completion loop CLOSED 2026-06-12
# (current_iteration=="DONE", all iterations i-x+M status=="complete"). Before this
# fix the alarm had NO terminal state, so once the plan finished it false-fired
# "stalled 86h at gate DONE" every 48h forever. Now: if the plan is done, log + exit 0,
# never ping. A plan that is COMPLETE cannot be STALLED.
# last_advanced_at + current gate + done-flag from loop-state (epoch via python, robust)
read -r last_epoch gate done <<<"$(/Users/chrisjackson/cortextos-data/warehouse/.venv/bin/python - "$LOOP" <<'PY'
import json,sys,datetime as dt
d=json.load(open(sys.argv[1]))
la=d.get('last_advanced_at','')
try:
    e=int(dt.datetime.fromisoformat(la.replace('Z','+00:00')).timestamp())
except Exception:
    e=0
cur=str(d.get('current_iteration','?'))
status=str(d.get('status',''))
# Terminal if the current iteration is an explicit terminal token, OR the loop
# status marks completion, OR every defined iteration has status=="complete".
iters=d.get('iterations',{})
all_complete = bool(iters) and all(
    str(v.get('status','')).lower()=='complete' for v in iters.values()
)
terminal = (
    cur.upper() in ('DONE','COMPLETE','CLOSED','FINISHED')
    or status.lower() in ('done','complete','completed','closed','finished')
    or all_complete
)
print(e, cur, '1' if terminal else '0')
PY
)"
# Terminal state: plan is done. Log once-per-run and exit without ever alarming.
if [ "${done:-0}" = "1" ]; then
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[$ts] DONE build-plan complete (gate $gate) — terminal, no alarm" >> "$STATEF.log" 2>/dev/null
  exit 0
fi
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
