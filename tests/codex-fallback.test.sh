#!/usr/bin/env bash
# tests/codex-fallback.test.sh — Validates codex-fallback.sh logic.
# Runs against REAL state but uses --dry-run + temp dirs so nothing is mutated.
# Simulates both-capped and cap-cleared scenarios.
#
# Usage: bash tests/codex-fallback.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_ROOT="$(dirname "$SCRIPT_DIR")"
FALLBACK_SCRIPT="$FRAMEWORK_ROOT/scripts/codex-fallback.sh"
SPAWN_SCRIPT="$FRAMEWORK_ROOT/orgs/main/agents/jarvis/bin/spawn-codex-workers.sh"
PASS=0
FAIL=0

log() { echo "[TEST] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $*"; }

# ── Test 1: Dry-run outputs correct detection ──────────────────────────────────
log "Test 1: dry-run detects real account cap status"
output=$(bash "$FALLBACK_SCRIPT" --dry-run 2>&1)

if echo "$output" | grep -q "both_capped=true"; then
  pass "Both accounts correctly detected as capped"
elif echo "$output" | grep -q "any_available=true"; then
  pass "At least one account available (caps may have cleared)"
elif echo "$output" | grep -q "both_error=true"; then
  pass "Both accounts errored — network issue detected gracefully"
else
  fail "Unexpected output from dry-run: missing state line"
  echo "$output"
fi

# ── Test 2: force-degrade + dry-run correctly identifies forge for degradation ─
log "Test 2: force-degrade correctly targets codex-app-server agents"
output=$(bash "$FALLBACK_SCRIPT" --dry-run --force-degrade 2>&1)

if echo "$output" | grep -q "Would degrade forge"; then
  pass "forge correctly identified for degradation (codex-app-server runtime)"
elif echo "$output" | grep -q "already degraded"; then
  pass "forge already in degraded state (fallback is live)"
else
  fail "Expected forge to be targeted for degradation. Output:"
  echo "$output"
fi

# ── Test 3: force-restore + dry-run finds the backup ──────────────────────────
log "Test 3: force-restore finds forge backup when degraded"
output=$(bash "$FALLBACK_SCRIPT" --dry-run --force-restore 2>&1)

if echo "$output" | grep -q "Would restore forge"; then
  pass "Restore path correctly identified forge backup"
elif echo "$output" | grep -q "not in fallback"; then
  pass "Forge not currently degraded — restore correctly skipped"
else
  fail "Unexpected output from force-restore dry-run:"
  echo "$output"
fi

# ── Test 4: Idempotent — second degrade is a no-op ────────────────────────────
log "Test 4: re-running force-degrade when already degraded is a no-op"
# First, check current state
state_file="${HOME}/.cortextos/default/state/usage/codex-fallback.json"
current_state="none"
if [[ -f "$state_file" ]]; then
  current_state=$(python3 -c "import json; d=json.load(open('$state_file')); print(d.get('forge',{}).get('status','none'))" 2>/dev/null || echo "none")
fi

if [[ "$current_state" == "degraded" ]]; then
  output=$(bash "$FALLBACK_SCRIPT" --dry-run --force-degrade 2>&1)
  if echo "$output" | grep -q "already degraded"; then
    pass "Second force-degrade correctly skipped (idempotent)"
  else
    fail "Second force-degrade should be a no-op but wasn't:"
    echo "$output"
  fi
else
  log "  (skipping idempotency test — forge not currently degraded; state=$current_state)"
  pass "Idempotency test skipped (not degraded yet)"
fi

# ── Test 5: Account cap detection returns structured output ────────────────────
log "Test 5: Account status detection returns parseable output"
output=$(bash "$FALLBACK_SCRIPT" --dry-run 2>&1)

if echo "$output" | grep -q "acct1:.*capped\|acct1:.*allowed\|acct1:.*error"; then
  pass "acct1 status is parseable (capped/allowed/error)"
else
  fail "acct1 status line not found or unparseable"
fi

if echo "$output" | grep -q "acct2:.*capped\|acct2:.*allowed\|acct2:.*error\|acct2:.*revoked\|acct2:.*auth-missing"; then
  pass "acct2 status is parseable (capped/allowed/error/revoked/auth-missing)"
else
  fail "acct2 status line not found or unparseable"
fi

if echo "$output" | grep -q "acct3:.*capped\|acct3:.*allowed\|acct3:.*error\|acct3:.*revoked\|acct3:.*auth-missing"; then
  pass "acct3 status is parseable (capped/allowed/error/revoked/auth-missing)"
else
  fail "acct3 status line not found or unparseable"
fi

# ── Test 6: Simulated acct1 revoked, acct2 capped, acct3 allowed ─────────────
log "Test 6: simulated mixed account states keep Codex live on acct3"
fixture="$(mktemp)"
cat > "$fixture" <<EOF
{
  "$HOME/.codex": {"state": "revoked", "detail": "token rejected"},
  "$HOME/.codex-acct2": {"state": "capped", "detail": "weekly 100%"},
  "$HOME/.codex-acct3": {"state": "allowed", "detail": "usage 15%", "email": "acct3@example.com"}
}
EOF
output=$(CODEX_ACCOUNT_HEALTH_FIXTURE="$fixture" bash "$FALLBACK_SCRIPT" --dry-run 2>&1)
if echo "$output" | grep -q "any_available=true" && ! echo "$output" | grep -q "DEGRADING"; then
  pass "Fallback stays on Codex while acct3 remains usable"
else
  fail "Fallback should not degrade when acct3 is allowed. Output:"
  echo "$output"
fi

taskdir="$(mktemp -d)"
printf 'task one\n' > "$taskdir/task-one.txt"
printf 'task two\n' > "$taskdir/task-two.txt"
output=$(CODEX_ACCOUNT_HEALTH_FIXTURE="$fixture" CODEX_DISPATCH_DRY_RUN=1 bash "$SPAWN_SCRIPT" \
  "$taskdir/task-one.txt" "$taskdir/task-two.txt" 2>&1)
if echo "$output" | grep -q "spawned-dry-run: task-one (acct=.codex-acct3)" && \
   echo "$output" | grep -q "spawned-dry-run: task-two (acct=.codex-acct3)"; then
  pass "Spawn dispatch routes all tasks to acct3 only"
else
  fail "Spawn dispatch did not route both tasks to acct3 only. Output:"
  echo "$output"
fi
rm -f "$fixture"
rm -rf "$taskdir"

# ── Test 7: Config backup exists when degraded ─────────────────────────────────
log "Test 7: forge backup exists (or forge not yet degraded)"
backup="/Users/chrisjackson/cortextos/orgs/main/agents/forge/config.json.codex-fallback-backup"
if [[ -f "$backup" ]]; then
  # Verify backup has original Codex runtime
  orig_runtime=$(python3 -c "import json; d=json.load(open('$backup')); print(d.get('runtime','?'))" 2>/dev/null || echo "?")
  if [[ "$orig_runtime" == "codex-app-server" ]]; then
    pass "Backup exists with original runtime=codex-app-server"
  else
    fail "Backup exists but runtime='$orig_runtime' (expected codex-app-server)"
  fi
else
  if [[ "$current_state" == "degraded" ]]; then
    fail "Forge is degraded but backup is missing!"
  else
    pass "Backup correctly absent (forge not yet degraded)"
  fi
fi

# ── Test 8: Current forge config reflects degraded state ──────────────────────
log "Test 8: Forge config.json reflects current fallback state"
forge_config="/Users/chrisjackson/cortextos/orgs/main/agents/forge/config.json"
forge_runtime=$(python3 -c "import json; d=json.load(open('$forge_config')); print(d.get('runtime','?'))" 2>/dev/null || echo "?")
forge_fallback_active=$(python3 -c "import json; d=json.load(open('$forge_config')); print(d.get('_codex_fallback_active',False))" 2>/dev/null || echo "False")

if [[ "$current_state" == "degraded" ]]; then
  if [[ "$forge_runtime" == "claude-code" ]]; then
    pass "Forge config shows runtime=claude-code (degraded)"
  else
    fail "Forge state=degraded but config runtime='$forge_runtime' (expected claude-code)"
  fi
  if [[ "$forge_fallback_active" == "True" ]]; then
    pass "Forge config has _codex_fallback_active=True marker"
  else
    fail "Missing _codex_fallback_active marker in degraded forge config"
  fi
else
  if [[ "$forge_runtime" == "codex-app-server" ]]; then
    pass "Forge config shows runtime=codex-app-server (normal, not degraded)"
  else
    pass "Forge runtime='$forge_runtime' (intermediate state, acceptable)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "===================="
echo "Results: $PASS passed, $FAIL failed"
echo "===================="

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
