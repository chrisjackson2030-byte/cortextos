#!/usr/bin/env bash
# codex-fallback.sh — Auto-degrade Codex agents to Claude when both Codex accounts are weekly-capped.
# Auto-restore when cap clears. Designed to run every 30 minutes as a cron/launchd job.
#
# What it does:
#   1. Checks acct1 (~/.codex) and acct2 (~/.codex-acct2) weekly cap status
#      via chatgpt.com/backend-api/codex/usage
#   2. If BOTH capped:
#      - Backs up each affected agent's config.json
#      - Sets runtime=claude-code, model=claude-sonnet-4-6 in config.json
#      - Triggers cortextos restart <agent> so daemon picks up new config
#      - Sends Telegram alert to Jarvis channel (never goes dark silently)
#   3. If cap CLEARS (either account becomes allowed):
#      - Restores original config.json from backup
#      - Restarts agent back onto Codex
#      - Sends recovery alert
#
#  Safety:
#   - Never modifies agents already on claude-code runtime
#   - Idempotent: skips if already in the right state
#   - Backs up config before any mutation
#   - Uses native `claude` CLI path only (never third-party harnesses)
#   - Both accounts must err before skip (transient errors don't trigger degrade)
#
# Usage:
#   bash codex-fallback.sh [--dry-run] [--force-degrade] [--force-restore]
#
# Wire as Jarvis cron (run once per session boot from CLAUDE.md or cron-management):
#   cortextos bus add-cron jarvis codex-fallback 30m \
#     "bash $CTX_FRAMEWORK_ROOT/scripts/codex-fallback.sh 2>&1 | tail -5"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Config ────────────────────────────────────────────────────────────────────
ACCT1_HOME="$HOME/.codex"
ACCT2_HOME="$HOME/.codex-acct2"
JARVIS_CHAT="7876203094"
FALLBACK_MODEL="claude-sonnet-4-6"
CLI="$FRAMEWORK_ROOT/dist/cli.js"
STATE_DIR="${HOME}/.cortextos/default/state/usage"
FALLBACK_STATE="$STATE_DIR/codex-fallback.json"
# Live-from-disk runtime-override stamp the boot generator reads each run so a
# runtime flip can never leave memory stale (prevent-recurrence for the 2026-06-15
# recall-miss: fallback rotated runtime but wrote nothing to memory).
RUNTIME_OVERRIDE_STATE="$FRAMEWORK_ROOT/orgs/main/agents/jarvis/state/agent-runtime-overrides.json"

# Agents to manage: space-separated "name:agent_dir" pairs
# Add new Codex-dependent agents here
CODEX_AGENT_PAIRS=(
  "forge:$FRAMEWORK_ROOT/orgs/main/agents/forge"
)
# Note: hermes was manually switched to claude-code already (config shows runtime=claude-code).
# Add it back here if it reverts to codex-app-server.

# ── CLI flags ──────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE_DEGRADE=false
FORCE_RESTORE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=true ;;
    --force-degrade) FORCE_DEGRADE=true ;;
    --force-restore) FORCE_RESTORE=true ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[codex-fallback $(ts)] $*"; }

send_telegram() {
  local msg="$1"
  if [[ -f "$CLI" ]]; then
    node "$CLI" bus send-telegram "$JARVIS_CHAT" "$msg" 2>/dev/null || true
  fi
}

# Check if a Codex account is capped by querying the usage API.
# Returns one of:
#   allowed:<weekly_pct>%:<email>
#   capped:<weekly_pct>%:<reset_minutes>m:<email>
#   error:<reason>
check_account_cap() {
  local home="$1"
  local auth_file="$home/auth.json"

  if [[ ! -f "$auth_file" ]]; then
    echo "error:auth.json_not_found"
    return
  fi

  python3 - "$auth_file" <<'PYEOF'
import json, base64, time, sys, urllib.request, urllib.error

auth_file = sys.argv[1]
try:
    auth = json.load(open(auth_file))
    toks = auth.get('tokens', auth)
    tok = toks.get('access_token', '')
    if not tok:
        print('error:no_access_token')
        sys.exit(0)

    # Check if token is still valid (>5 min remaining)
    seg = tok.split('.')[1]
    seg += '=' * (-len(seg) % 4)
    payload = json.loads(base64.urlsafe_b64decode(seg))
    access_token = tok

    if payload.get('exp', 0) - time.time() <= 300:
        # Try refresh
        refresh_token = toks.get('refresh_token', '')
        if not refresh_token:
            print('error:token_expired_no_refresh')
            sys.exit(0)
        try:
            req = urllib.request.Request(
                'https://auth.openai.com/oauth/token',
                data=json.dumps({
                    'grant_type': 'refresh_token',
                    'refresh_token': refresh_token,
                    'client_id': 'app_EMoamEEZ73f0CkXaXp7hrann'
                }).encode(),
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read())
                access_token = d.get('access_token', '')
                if not access_token:
                    print('error:refresh_failed_no_token')
                    sys.exit(0)
        except Exception as e:
            print(f'error:refresh_failed:{e}')
            sys.exit(0)

    # Query the Codex usage API
    req = urllib.request.Request(
        'https://chatgpt.com/backend-api/codex/usage',
        headers={
            'Authorization': f'Bearer {access_token}',
            'User-Agent': 'codex-cli',
            'Accept': 'application/json'
        }
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        u = json.loads(r.read())

    rl = u.get('rate_limit', {})
    allowed = rl.get('allowed', True)
    limit_reached = rl.get('limit_reached', False)
    sec = rl.get('secondary_window', {})
    weekly_pct = sec.get('used_percent', 0) or 0
    reset_secs = sec.get('reset_after_seconds') or 0
    reset_min = int(reset_secs / 60)
    email = u.get('email', 'unknown') or 'unknown'

    if not allowed or limit_reached:
        print(f'capped:{weekly_pct:.0f}%:{reset_min}m:{email}')
    else:
        print(f'allowed:{weekly_pct:.0f}%:{email}')

except Exception as e:
    print(f'error:{e}')
PYEOF
}

# Get current runtime from agent's config.json
get_agent_runtime() {
  local config="$1/config.json"
  [[ -f "$config" ]] || { echo "unknown"; return; }
  python3 -c "
import json, sys
try:
    d = json.load(open('$config'))
    print(d.get('runtime', 'claude-code'))
except:
    print('unknown')
" 2>/dev/null || echo "unknown"
}

# Get fallback state for an agent from the state JSON
get_fallback_state() {
  local agent="$1"
  [[ -f "$FALLBACK_STATE" ]] || { echo "none"; return; }
  python3 -c "
import json, sys
try:
    d = json.load(open('$FALLBACK_STATE'))
    print(d.get('$agent', {}).get('status', 'none'))
except:
    print('none')
" 2>/dev/null || echo "none"
}

# Write fallback state for an agent
set_fallback_state() {
  local agent="$1"
  local status="$2"
  local reason="${3:-}"
  local original_runtime="${4:-}"
  local original_model="${5:-}"

  mkdir -p "$STATE_DIR"
  python3 - "$FALLBACK_STATE" "$agent" "$status" "$reason" "$original_runtime" "$original_model" <<'PYEOF'
import json, sys
from datetime import datetime, timezone

state_file, agent, status, reason, orig_rt, orig_model = (sys.argv[1], sys.argv[2],
    sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])

try:
    state = json.load(open(state_file))
except Exception:
    state = {}

if agent not in state:
    state[agent] = {}

state[agent]['status'] = status
state[agent]['updated_at'] = datetime.now(timezone.utc).isoformat()
if reason:
    state[agent]['reason'] = reason
if orig_rt:
    state[agent]['original_runtime'] = orig_rt
if orig_model:
    state[agent]['original_model'] = orig_model

json.dump(state, open(state_file, 'w'), indent=2)
PYEOF
}

# Stamp the LIVE runtime-override file that the boot generator reads each run.
# This makes "agent runtime" a live-from-disk fact (like the trading registry),
# so a runtime flip can never leave memory prose stale (2026-06-15 recall-miss fix).
# Idempotent + atomic (tmp file + os.replace). Records the flip transition.
stamp_runtime_override() {
  local agent="$1"
  local from_runtime="$2"
  local to_runtime="$3"
  local reason="${4:-}"

  [[ "$DRY_RUN" == "true" ]] && { log "[DRY-RUN] Would stamp runtime override: $agent $from_runtime -> $to_runtime ($reason)"; return 0; }

  mkdir -p "$(dirname "$RUNTIME_OVERRIDE_STATE")"
  python3 - "$RUNTIME_OVERRIDE_STATE" "$agent" "$from_runtime" "$to_runtime" "$reason" <<'PYEOF'
import json, os, sys
from datetime import datetime, timezone

state_file, agent, from_rt, to_rt, reason = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])

try:
    state = json.load(open(state_file))
    if not isinstance(state, dict):
        state = {}
except Exception:
    state = {}

now = datetime.now(timezone.utc).isoformat()
entry = {
    "agent": agent,
    "from_runtime": from_rt,
    "to_runtime": to_rt,
    "reason": reason,
    "timestamp": now,
    "stamped_by": "codex-fallback.sh",
}

prev = state.get(agent)
# Idempotent: only rewrite the timestamp-bearing record if the override changed.
if isinstance(prev, dict) and prev.get("to_runtime") == to_rt and prev.get("from_runtime") == from_rt:
    entry["timestamp"] = prev.get("timestamp", now)  # preserve first-flip time

state[agent] = entry
state["_updated_at"] = now

tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
print(f"  runtime-override stamped: {agent} {from_rt} -> {to_rt}")
PYEOF
}

# Degrade an agent from codex-app-server to claude-code
degrade_agent() {
  local agent="$1"
  local agent_dir="$2"
  local config="$agent_dir/config.json"
  local backup="$agent_dir/config.json.codex-fallback-backup"

  if [[ ! -f "$config" ]]; then
    log "ERROR: config.json not found for $agent at $config"
    return 1
  fi

  # Read current runtime/model
  local current_runtime current_model
  current_runtime=$(python3 -c "import json; d=json.load(open('$config')); print(d.get('runtime','claude-code'))" 2>/dev/null || echo "claude-code")
  current_model=$(python3 -c "import json; d=json.load(open('$config')); print(d.get('model',''))" 2>/dev/null || echo "")

  # Already on claude-code — mark degraded but no restart needed
  if [[ "$current_runtime" == "claude-code" ]]; then
    log "$agent: already on claude-code runtime (possibly manually switched). Marking degraded."
    if [[ "$DRY_RUN" == "false" ]]; then
      set_fallback_state "$agent" "degraded" "already_claude" "$current_runtime" "$current_model"
      stamp_runtime_override "$agent" "$current_runtime" "claude-code" "codex_weekly_cap (already_claude)"
    fi
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would degrade $agent: $current_runtime/$current_model → claude-code/$FALLBACK_MODEL"
    return 0
  fi

  # Back up original config
  cp "$config" "$backup"
  log "$agent: backed up config.json → config.json.codex-fallback-backup"

  # Mutate config: set runtime + model
  python3 - "$config" "$FALLBACK_MODEL" <<'PYEOF'
import json, sys

config_path, fallback_model = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    d = json.load(f)
d['runtime'] = 'claude-code'
d['model'] = fallback_model
d['_codex_fallback_active'] = True
with open(config_path, 'w') as f:
    json.dump(d, f, indent=2)
print(f"  runtime → claude-code, model → {fallback_model}")
PYEOF

  log "$agent: config.json updated"

  # Record state
  set_fallback_state "$agent" "degraded" "codex_weekly_cap" "$current_runtime" "$current_model"
  stamp_runtime_override "$agent" "$current_runtime" "claude-code" "codex_weekly_cap"

  # Restart via daemon IPC
  log "$agent: triggering daemon restart..."
  if node "$CLI" restart "$agent" 2>/dev/null; then
    log "$agent: restart triggered"
  else
    log "$agent: restart command failed — config change will apply on next daemon start"
  fi
}

# Restore an agent from the backup config
restore_agent() {
  local agent="$1"
  local agent_dir="$2"
  local config="$agent_dir/config.json"
  local backup="$agent_dir/config.json.codex-fallback-backup"

  if [[ ! -f "$backup" ]]; then
    log "$agent: no backup at $backup — cannot auto-restore. Check manually."
    return 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would restore $agent from backup"
    return 0
  fi

  cp "$backup" "$config"
  rm -f "$backup"
  log "$agent: config.json restored from backup"

  # Read the runtime we just restored TO so the override stamp is accurate.
  local restored_runtime
  restored_runtime=$(python3 -c "import json; d=json.load(open('$config')); print(d.get('runtime','codex-app-server'))" 2>/dev/null || echo "codex-app-server")

  set_fallback_state "$agent" "normal" "" "" ""
  stamp_runtime_override "$agent" "claude-code" "$restored_runtime" "codex_cap_cleared"

  log "$agent: triggering daemon restart..."
  if node "$CLI" restart "$agent" 2>/dev/null; then
    log "$agent: restart triggered"
  else
    log "$agent: restart command failed — config change will apply on next daemon start"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

mkdir -p "$STATE_DIR"
log "=== Codex fallback check starting ==="

# Check both accounts
log "Checking acct1 ($ACCT1_HOME)..."
acct1_result=$(check_account_cap "$ACCT1_HOME")
log "  acct1: $acct1_result"

log "Checking acct2 ($ACCT2_HOME)..."
acct2_result=$(check_account_cap "$ACCT2_HOME")
log "  acct2: $acct2_result"

acct1_status=$(echo "$acct1_result" | cut -d: -f1)
acct2_status=$(echo "$acct2_result" | cut -d: -f1)

# Determine overall state
both_capped=false
any_available=false
both_error=false

if [[ "$acct1_status" == "capped" && "$acct2_status" == "capped" ]]; then
  both_capped=true
elif [[ "$acct1_status" == "allowed" || "$acct2_status" == "allowed" ]]; then
  any_available=true
elif [[ "$acct1_status" == "error" && "$acct2_status" == "error" ]]; then
  both_error=true
fi

# Force flags for testing
[[ "$FORCE_DEGRADE" == "true" ]] && both_capped=true && any_available=false && both_error=false && log "[FORCE_DEGRADE]"
[[ "$FORCE_RESTORE" == "true" ]] && both_capped=false && any_available=true && both_error=false && log "[FORCE_RESTORE]"

log "State → both_capped=$both_capped | any_available=$any_available | both_error=$both_error"

# Process each Codex agent
degraded_agents=""
restored_agents=""

for pair in "${CODEX_AGENT_PAIRS[@]}"; do
  agent="${pair%%:*}"
  agent_dir="${pair#*:}"

  current_fallback=$(get_fallback_state "$agent")
  current_runtime=$(get_agent_runtime "$agent_dir")
  log "Agent $agent: runtime=$current_runtime, fallback_state=$current_fallback"

  if [[ "$both_capped" == "true" ]]; then
    if [[ "$current_fallback" == "degraded" ]]; then
      log "$agent: already degraded — skip"
    else
      log "$agent: DEGRADING → claude-code (both Codex accounts weekly-capped)"
      if degrade_agent "$agent" "$agent_dir"; then
        degraded_agents="${degraded_agents:+$degraded_agents, }$agent"
      fi
    fi

  elif [[ "$any_available" == "true" ]]; then
    if [[ "$current_fallback" == "degraded" ]]; then
      log "$agent: cap cleared — RESTORING Codex runtime"
      if restore_agent "$agent" "$agent_dir"; then
        restored_agents="${restored_agents:+$restored_agents, }$agent"
      fi
    else
      log "$agent: cap clear, not in fallback — no action"
    fi

  elif [[ "$both_error" == "true" ]]; then
    log "$agent: both accounts returned errors (network/transient?) — skipping degrade"
  fi
done

# Telegram alerts
if [[ -n "$degraded_agents" && "$DRY_RUN" == "false" ]]; then
  reset_hint=$(echo "$acct2_result" | grep -oE '[0-9]+m' | head -1 || echo "unknown")
  send_telegram "CODEX FALLBACK ACTIVE: Both accounts weekly-capped (acct1=$acct1_result, acct2=$acct2_result). Degraded to Claude Sonnet: [$degraded_agents]. Reset in ~$reset_hint. Will auto-restore when cap clears."
  log "Degradation alert sent"
fi

if [[ -n "$restored_agents" && "$DRY_RUN" == "false" ]]; then
  available="${acct1_status}/${acct2_status}"
  send_telegram "CODEX RESTORED: Weekly cap cleared. Agents [$restored_agents] restored to Codex runtime and restarted. (acct status: $available)"
  log "Restoration alert sent"
fi

# Write last-check summary
python3 - "$FALLBACK_STATE" "$acct1_result" "$acct2_result" \
          "$( [[ $both_capped == true ]] && echo True || echo False )" \
          "$( [[ $any_available == true ]] && echo True || echo False )" \
          "$degraded_agents" "$restored_agents" <<'PYEOF'
import json, sys
from datetime import datetime, timezone

state_file, a1, a2, both_capped, any_avail, degraded, restored = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7])

try:
    state = json.load(open(state_file))
except Exception:
    state = {}

state['_last_check'] = {
    'ts': datetime.now(timezone.utc).isoformat(),
    'acct1': a1, 'acct2': a2,
    'both_capped': both_capped == 'True',
    'any_available': any_avail == 'True',
    'degraded': degraded, 'restored': restored
}

json.dump(state, open(state_file, 'w'), indent=2)
PYEOF

log "=== Done. Degraded=[$degraded_agents] Restored=[$restored_agents] ==="
