#!/bin/bash
# Claude Max weekly cap monitor for cortextOS.
#
# Parses ~/.claude/projects/ JSONL session files to compute this week's
# token consumption rate and project whether the cap will be hit.
# Alerts via Telegram at configurable thresholds (default: 70%, 85%, 95%).
#
# Designed to be run every 2-4 hours via launchd.
# Launchd plist: config/launchd/com.cortextos.weekly-cap-monitor.plist
#
# Claude Max weekly resets Monday 00:00 UTC.
# We don't know the exact cap, so we track rate/trajectory instead,
# plus day-over-day comparisons to spot acceleration.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
STATE_DIR="$HOME/.cortextos/$INSTANCE/state/usage"
STATE_FILE="$STATE_DIR/weekly-cap-state.json"
LOG_FILE="$HOME/.cortextos/$INSTANCE/logs/weekly-cap-monitor.log"
CLAUDE_PROJECTS="$HOME/.claude/projects"

# Alert thresholds: sessions-per-day multiples vs the day-1 baseline
# We alert when today's session count is > YELLOW_MULT * yesterday's
# (i.e., fleet is running much hotter than normal)
YELLOW_MULT="${WEEKLY_YELLOW_MULT:-2.5}"
RED_MULT="${WEEKLY_RED_MULT:-4.0}"

# Hard API-response-count alert (week_sessions = total JSONL assistant turns).
# Calibrated 2026-05-12: B's fleet hit the weekly cap at ~9256 turns (2 days in).
# YELLOW = 70% of observed cap, RED = 85%. Adjust after 2+ weeks of data.
YELLOW_SESSIONS="${WEEKLY_YELLOW_SESSIONS:-6500}"
RED_SESSIONS="${WEEKLY_RED_SESSIONS:-8000}"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

# Auto-detect orchestrator .env for Telegram credentials
ALERT_BOT_ENV="${CORTEXTOS_ALERT_BOT_ENV:-}"
JQ_BIN="$(command -v jq)"
if [ -z "$ALERT_BOT_ENV" ] && [ -n "$JQ_BIN" ]; then
  for ctx in "$FRAMEWORK_ROOT"/orgs/*/context.json; do
    [ -f "$ctx" ] || continue
    orch=$("$JQ_BIN" -r '.orchestrator // empty' "$ctx")
    [ -z "$orch" ] && continue
    org=$(basename "$(dirname "$ctx")")
    candidate="$FRAMEWORK_ROOT/orgs/$org/agents/$orch/.env"
    [ -f "$candidate" ] && ALERT_BOT_ENV="$candidate" && break
  done
fi

BOT_TOKEN=""
CHAT_ID=""
if [ -n "$ALERT_BOT_ENV" ] && [ -f "$ALERT_BOT_ENV" ]; then
  BOT_TOKEN=$(grep -E "^BOT_TOKEN=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
  CHAT_ID=$(grep -E "^CHAT_ID=" "$ALERT_BOT_ENV" 2>/dev/null | cut -d= -f2)
fi

send_telegram() {
  local msg="$1"
  [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] && return
  curl -sS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": ${CHAT_ID}, \"text\": $(echo "$msg" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'), \"parse_mode\": \"Markdown\"}" \
    >> "$LOG_FILE" 2>&1
}

# Compute current week's Monday 00:00 UTC as epoch
python3 - <<'PYEOF' > /tmp/weekly_cap_stats.json
import os, json, glob, sys
from datetime import datetime, timezone, timedelta

claude_dir = os.path.expanduser("~/.claude/projects")
now = datetime.now(timezone.utc)

# Monday of current ISO week
week_start = now - timedelta(days=now.weekday())
week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)

# Yesterday's date for comparison
yesterday_start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

week_sessions = 0
week_input_tokens = 0
week_output_tokens = 0
week_cache_tokens = 0
today_sessions = 0
yesterday_sessions = 0

for jsonl in glob.glob(os.path.join(claude_dir, "*", "*.jsonl")):
    try:
        mtime = datetime.fromtimestamp(os.path.getmtime(jsonl), tz=timezone.utc)
        if mtime < week_start:
            continue  # skip files not touched this week
        with open(jsonl, 'r', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                # Only count assistant turns that have usage (not user turns)
                ts_str = obj.get('timestamp', '')
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                except Exception:
                    continue
                if ts < week_start:
                    continue
                usage = obj.get('message', {}).get('usage', {})
                if not usage:
                    # Also check top-level usage
                    usage = obj.get('usage', {})
                if not usage:
                    continue
                week_sessions += 1
                week_input_tokens += usage.get('input_tokens', 0)
                week_output_tokens += usage.get('output_tokens', 0)
                week_cache_tokens += usage.get('cache_creation_input_tokens', 0)
                if ts >= today_start:
                    today_sessions += 1
                elif ts >= yesterday_start:
                    yesterday_sessions += 1
    except Exception:
        continue

# Days elapsed in this week (at least 1 to avoid div by 0)
days_elapsed = max(1, now.weekday() + 1)
daily_avg = week_sessions / days_elapsed
hours_into_day = now.hour + now.minute / 60
today_rate = (today_sessions / max(1, hours_into_day)) * 24 if hours_into_day > 0 else 0

print(json.dumps({
    "week_sessions": week_sessions,
    "today_sessions": today_sessions,
    "yesterday_sessions": yesterday_sessions,
    "week_input_tokens": week_input_tokens,
    "week_output_tokens": week_output_tokens,
    "week_cache_tokens": week_cache_tokens,
    "days_elapsed": days_elapsed,
    "daily_avg": round(daily_avg, 1),
    "today_rate_projected": round(today_rate, 1),
    "week_start_iso": week_start.isoformat(),
    "computed_at": now.isoformat()
}))
PYEOF

if [ ! -f /tmp/weekly_cap_stats.json ]; then
  echo "[$ts] ERROR: Python stats computation failed" >> "$LOG_FILE"
  exit 1
fi

if [ -n "$JQ_BIN" ]; then
  week_sessions=$("$JQ_BIN" -r '.week_sessions' /tmp/weekly_cap_stats.json)
  today_sessions=$("$JQ_BIN" -r '.today_sessions' /tmp/weekly_cap_stats.json)
  yesterday_sessions=$("$JQ_BIN" -r '.yesterday_sessions' /tmp/weekly_cap_stats.json)
  daily_avg=$("$JQ_BIN" -r '.daily_avg' /tmp/weekly_cap_stats.json)
  today_rate=$("$JQ_BIN" -r '.today_rate_projected' /tmp/weekly_cap_stats.json)
  week_input=$("$JQ_BIN" -r '.week_input_tokens' /tmp/weekly_cap_stats.json)
  week_output=$("$JQ_BIN" -r '.week_output_tokens' /tmp/weekly_cap_stats.json)
  days_elapsed=$("$JQ_BIN" -r '.days_elapsed' /tmp/weekly_cap_stats.json)
else
  week_sessions=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['week_sessions'])")
  today_sessions=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['today_sessions'])")
  yesterday_sessions=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['yesterday_sessions'])")
  daily_avg=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['daily_avg'])")
  today_rate=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['today_rate_projected'])")
  week_input=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['week_input_tokens'])")
  week_output=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['week_output_tokens'])")
  days_elapsed=$(python3 -c "import json; d=json.load(open('/tmp/weekly_cap_stats.json')); print(d['days_elapsed'])")
fi

# Determine tier based on session count AND today-vs-yesterday multiplier
tier="GREEN"
reason="normal"

# Check absolute session count threshold
if [ "$(echo "$week_sessions >= $RED_SESSIONS" | python3 -c 'import sys; print("1" if eval(sys.stdin.read()) else "0")')" = "1" ]; then
  tier="RED"
  reason="sessions near cap (${week_sessions}/${RED_SESSIONS})"
elif [ "$(echo "$week_sessions >= $YELLOW_SESSIONS" | python3 -c 'import sys; print("1" if eval(sys.stdin.read()) else "0")')" = "1" ]; then
  tier="YELLOW"
  reason="sessions elevated (${week_sessions}/${YELLOW_SESSIONS})"
fi

# Check acceleration: today vs yesterday
if [ "$yesterday_sessions" -gt 10 ] 2>/dev/null; then
  mult=$(python3 -c "print(round($today_sessions / max(1, $yesterday_sessions), 2))")
  if [ "$(python3 -c "print('1' if $mult >= $RED_MULT else '0')")" = "1" ]; then
    [ "$tier" = "GREEN" ] && tier="RED" && reason="today ${today_sessions} sessions = ${mult}x yesterday (${yesterday_sessions})"
  elif [ "$(python3 -c "print('1' if $mult >= $YELLOW_MULT else '0')")" = "1" ]; then
    [ "$tier" = "GREEN" ] && tier="YELLOW" && reason="today ${today_sessions} sessions = ${mult}x yesterday (${yesterday_sessions})"
  fi
fi

last_tier=$(python3 -c "import json,os; d=json.load(open('$STATE_FILE')) if os.path.exists('$STATE_FILE') else {}; print(d.get('tier','GREEN'))" 2>/dev/null || echo "GREEN")

# Save state
python3 -c "
import json, os
d = json.load(open('/tmp/weekly_cap_stats.json'))
d['tier'] = '$tier'
d['reason'] = '$reason'
with open('$STATE_FILE', 'w') as f:
    json.dump(d, f, indent=2)
"

echo "[$ts] tier=$tier week_sessions=$week_sessions today=$today_sessions yesterday=$yesterday_sessions daily_avg=$daily_avg reason=$reason" >> "$LOG_FILE"

# Alert logic: on tier change OR every check while RED
should_alert=0
[ "$tier" != "$last_tier" ] && should_alert=1
[ "$tier" = "RED" ] && should_alert=1

if [ "$should_alert" -eq 1 ] && [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  case "$tier" in
    RED)    icon="🔴" label="HIGH" ;;
    YELLOW) icon="🟡" label="ELEVATED" ;;
    GREEN)  icon="🟢" label="NORMAL" ;;
  esac
  msg="${icon} *Weekly Cap Monitor — ${label}*
Week sessions: *${week_sessions}* (avg ${daily_avg}/day, day ${days_elapsed}/7)
Today: *${today_sessions}* sessions | Yesterday: ${yesterday_sessions}
Today projected: ~${today_rate} sessions

_${reason}_"

  if [ "$tier" = "RED" ]; then
    msg="$msg

🚨 Fleet running hot. Stop non-critical agents (\`cortextos stop <agent>\`) or pause crons until tomorrow."
  elif [ "$tier" = "YELLOW" ]; then
    msg="$msg

Watching. Run: \`cortextos bus list-crons\` to identify busy agents."
  elif [ "$tier" = "GREEN" ] && [ "$last_tier" != "GREEN" ]; then
    msg="$msg

✅ Consumption normalized. (Was: ${last_tier})"
  fi

  send_telegram "$msg"
fi

rm -f /tmp/weekly_cap_stats.json
