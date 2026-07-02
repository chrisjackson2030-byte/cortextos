#!/usr/bin/env bash
# SANDBOX CANARY enforcement tests (Gate H / FEATURE_SANDBOX_CANARY).
#
# Runs the real macOS sandbox-exec against the canary profile and proves the
# four required behaviours. Uses a PLANTED FAKE canary secret only. It never
# reads, prints, or touches any real Keychain item or real credential.
#
# Scope: exercises cortextos-atlas-canary.sb — the profile for the ONE canary
# agent (atlas). This does NOT enable the feature flag and does NOT start atlas.
#
# Usage: bash config/sandbox/test-sandbox-canary.sh
# Exit 0 = all four tests + the no-external-action check passed.

set -u

PROJ="/Users/chrisjackson/cortextos"
PROFILE="$PROJ/config/sandbox/cortextos-atlas-canary.sb"
SENTINEL="/nonexistent-sandbox-placeholder"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "SKIP: sandbox-exec is macOS-only (uname=$(uname))"
  exit 0
fi

# ── Isolated scratch dirs (no real agent/ctx touched) ────────────────────────
# NOTE: place scratch OUTSIDE /tmp and /var/folders. The canary profile allows
# writes to /private/var/folders + /private/tmp (Node.js internals), so a fake
# secret or an "outside" path placed there would be writable by design and the
# tests would be meaningless. We canonicalize the path (realpath) because macOS
# Seatbelt matches on the resolved path (/var/... -> /private/var/...) and the
# deny rule must reference the same resolved path the kernel sees.
SCRATCH_BASE="$PROJ/.sandbox-canary-scratch"
mkdir -p "$SCRATCH_BASE"
SCRATCH="$(mktemp -d "$SCRATCH_BASE/run.XXXXXX")"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"   # canonicalize (resolve symlinks)
AGENT_DIR="$SCRATCH/agent"
CTX_ROOT="$SCRATCH/ctx"
PROJ_DIR="$SCRATCH/proj"
FAKE_CANARY_DIR="$SCRATCH/fake-secrets"
OUTSIDE="$SCRATCH/outside"   # a path NOT in any allowed write scope
mkdir -p "$AGENT_DIR" "$CTX_ROOT" "$PROJ_DIR" "$FAKE_CANARY_DIR" "$OUTSIDE"

# Legit content the canary is allowed to read/work with.
echo "legit task input" > "$AGENT_DIR/task.md"

# PLANT A FAKE CANARY SECRET (never a real credential).
FAKE_SECRET_VALUE="canary_fake_secret_DO_NOT_TRUST_$(date +%s)"
echo "$FAKE_SECRET_VALUE" > "$FAKE_CANARY_DIR/canary-token.txt"

cleanup() { rm -rf "$SCRATCH_BASE"; rm -f "$HOME/.claude/INJECTED" 2>/dev/null; }
trap cleanup EXIT

run_sandboxed() {
  # $1 = command string run under the canary sandbox
  sandbox-exec -f "$PROFILE" \
    -D "AGENT_DIR=$AGENT_DIR" \
    -D "CTX_ROOT=$CTX_ROOT" \
    -D "HOME_DIR=$HOME" \
    -D "CLAUDE_PROJ_DIR=$PROJ_DIR" \
    -D "DAEMON_SOCK=$CTX_ROOT/daemon.sock" \
    -D "DENY_AGENT_1=$SENTINEL" \
    -D "DENY_AGENT_2=$SENTINEL" \
    -D "DENY_AGENT_3=$SENTINEL" \
    -D "DENY_AGENT_4=$SENTINEL" \
    -D "FAKE_CANARY_DIR=$FAKE_CANARY_DIR" \
    /bin/bash -c "$1" 2>&1
}

PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== SANDBOX CANARY enforcement tests ==="
echo "profile: $PROFILE"
echo

# ── TEST 1: deny-cred — Keychain + securityd are blocked ─────────────────────
# Attempt to read the user Keychain dir from inside the sandbox.
OUT="$(run_sandboxed 'ls -la "$HOME/Library/Keychains" 2>&1; echo "RC=$?"')"
if echo "$OUT" | grep -qi "not permitted\|operation not permitted"; then
  ok "deny-cred: read of ~/Library/Keychains BLOCKED (Operation not permitted)"
else
  bad "deny-cred: ~/Library/Keychains was NOT blocked -> $OUT"
fi
# Attempt to use the `security` CLI (talks to securityd via mach) inside sandbox.
# Unsandboxed it lists real keychain paths; sandboxed the securityd mach denial
# makes SecKeychainCopySearchList fail, so no keychain path is returned.
OUT2="$(run_sandboxed '/usr/bin/security list-keychains 2>&1')"
if echo "$OUT2" | grep -q "Keychains/" ; then
  bad "deny-cred: security CLI returned real keychain paths -> $OUT2"
else
  ok "deny-cred: securityd blocked — 'security list-keychains' returned no keychain paths"
fi

# ── TEST 2: fake-canary-cred — planted fake secret read is DENIED ────────────
OUT="$(run_sandboxed "cat '$FAKE_CANARY_DIR/canary-token.txt' 2>&1; echo RC=\$?")"
if echo "$OUT" | grep -qi "not permitted\|operation not permitted"; then
  ok "fake-canary-cred: planted fake secret read BLOCKED"
else
  if echo "$OUT" | grep -q "$FAKE_SECRET_VALUE"; then
    bad "fake-canary-cred: sandbox LEAKED the fake secret value"
  else
    bad "fake-canary-cred: unexpected result -> $OUT"
  fi
fi

# ── TEST 3: prompt-injection — malicious instruction is contained ────────────
# Simulate a malicious prompt that tells the agent to (a) read the fake secret
# and (b) exfiltrate it by writing it somewhere outside its allowed scope.
# Both the read AND the out-of-scope write must be denied by the sandbox, so the
# attacker cannot obtain or move the secret regardless of the agent complying.
INJECT="cat '$FAKE_CANARY_DIR/canary-token.txt' > '$OUTSIDE/exfil.txt' 2>&1; \
        echo READ_RC=\$?; \
        echo OVERWRITE_HOME=\$( ( echo pwned > '$HOME/.claude/INJECTED' ) 2>&1 ); \
        ls '$OUTSIDE/exfil.txt' 2>&1"
OUT="$(run_sandboxed "$INJECT")"
# Secret must NOT have landed outside the sandbox, and the home write must fail.
if [[ ! -s "$OUTSIDE/exfil.txt" ]] && ! grep -q "$FAKE_SECRET_VALUE" "$OUTSIDE/exfil.txt" 2>/dev/null; then
  ok "prompt-injection: exfil of fake secret to out-of-scope path BLOCKED"
else
  bad "prompt-injection: fake secret was exfiltrated -> $(cat "$OUTSIDE/exfil.txt" 2>/dev/null)"
fi
if [[ ! -f "$HOME/.claude/INJECTED" ]] && echo "$OUT" | grep -qi "not permitted\|operation not permitted"; then
  ok "prompt-injection: out-of-scope write to ~/.claude BLOCKED"
else
  bad "prompt-injection: home write was NOT blocked -> $OUT"
  rm -f "$HOME/.claude/INJECTED" 2>/dev/null
fi

# ── TEST 4: normal-task-works — legitimate work still succeeds ───────────────
OUT="$(run_sandboxed "
  in=\$(cat '$AGENT_DIR/task.md');
  echo \"result for: \$in\" > '$AGENT_DIR/result.md' && echo AGENT_WRITE_OK;
  echo bus-event > '$CTX_ROOT/event.log' && echo CTX_WRITE_OK;
  cat '$AGENT_DIR/result.md'
")"
if echo "$OUT" | grep -q "AGENT_WRITE_OK" \
   && echo "$OUT" | grep -q "CTX_WRITE_OK" \
   && [[ -s "$AGENT_DIR/result.md" ]] \
   && [[ -s "$CTX_ROOT/event.log" ]]; then
  ok "normal-task-works: read input + write own dir + write CTX_ROOT all succeeded"
else
  bad "normal-task-works: legitimate task broke -> $OUT"
fi

# ── EXTRA: no-external-action sanity — out-of-scope write denied ─────────────
OUT="$(run_sandboxed "echo x > '$OUTSIDE/should-fail.txt' 2>&1; echo RC=\$?")"
if [[ ! -f "$OUTSIDE/should-fail.txt" ]]; then
  ok "no-external-action: write outside agent/CTX scope BLOCKED"
else
  bad "no-external-action: out-of-scope write succeeded -> $OUT"
fi

echo
echo "=== RESULT: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
