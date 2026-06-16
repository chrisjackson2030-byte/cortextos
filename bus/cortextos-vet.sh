#!/usr/bin/env bash
# cortextos-vet — pull-vetting sandbox for external packages
#
# Runs available security scanners against a package before installation.
# Degrades gracefully when tools are missing (logs SKIP, doesn't fail).
# Returns: 0=PASS (all available layers pass), 1=FAIL (any layer found issues)
#
# Usage:
#   cortextos-vet pypi <package> [--version X]
#   cortextos-vet npm <package> [--version X]
#   cortextos-vet github <owner/repo>
#   cortextos-vet --dry-run pypi requests    # show what WOULD run, don't execute

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VET_VENV="${SCRIPT_DIR}/../orgs/main/agents/jarvis/state/security/vet-venv"
if [[ -d "$VET_VENV/bin" ]]; then
  export PATH="$VET_VENV/bin:$PATH"
fi

VERSION=""
DRY_RUN=false
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

ECOSYSTEM="${POSITIONAL[0]:-}"
PACKAGE="${POSITIONAL[1]:-}"
# Finding 11 fix: predictable /tmp/cortextos-vet-<timestamp> was a TOCTOU symlink
# target (attacker pre-creates the path as a symlink; mkdir/writes follow it).
# Use mktemp -d with 700 perms so the dir is unguessable and owner-only.
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cortextos-vet-XXXXXXXX")"

if [[ -z "$ECOSYSTEM" || -z "$PACKAGE" ]]; then
  echo "Usage: cortextos-vet <pypi|npm|github> <package> [--version X] [--dry-run]"
  rmdir "$REPORT_DIR" 2>/dev/null || true
  exit 2
fi
FAILURES=0
SKIPS=0
PASSES=0

log() { echo "[VET] $*"; }
pass() { log "PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { log "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
skip() { log "SKIP: $1 (tool not installed)"; SKIPS=$((SKIPS + 1)); }

# ── Layer 1: Known CVEs ──────────────────────────────────────────────────────
log "=== Layer 1: Known CVEs ==="
if [[ "$ECOSYSTEM" == "pypi" ]]; then
  if command -v pip-audit &>/dev/null; then
    if $DRY_RUN; then
      log "Would run: pip-audit --requirement=<(echo '$PACKAGE') -f json"
    else
      VSTR="${PACKAGE}"
      [[ -n "$VERSION" ]] && VSTR="${PACKAGE}==${VERSION}"
      if pip-audit --requirement=<(echo "$VSTR") -f json > "$REPORT_DIR/pip-audit.json" 2>&1; then
        pass "Layer 1 (pip-audit)"
      else
        fail "Layer 1 (pip-audit) — found vulnerabilities"
      fi
    fi
  else
    skip "Layer 1 (pip-audit)"
  fi
elif [[ "$ECOSYSTEM" == "npm" ]]; then
  if $DRY_RUN; then
    log "Would run: npm audit for $PACKAGE"
  else
    TMPDIR_NPM=$(mktemp -d)
    # WS6.4 (rc=134 fix): under `set -euo pipefail` an UNGUARDED npm/node call here
    # propagated a transient child crash (SIGABRT=134, or 127) as the script's own
    # exit code, aborting the whole vet BEFORE the verdict block. The gate then saw
    # a non-0/1 rc → INCONCLUSIVE → install proceeded UNVETTED. These setup calls
    # (cd/init/install) only RESOLVE the dependency tree (no package code executes);
    # the real verdict comes from `npm audit` + later layers. So a transient setup
    # failure must DEGRADE (skip-to-audit), never kill the vet. Guard each one so
    # the script always reaches a verdict.
    cd "$TMPDIR_NPM" || { skip "Layer 1 (npm — workdir unavailable)"; TMPDIR_NPM=""; }
    if [[ -n "$TMPDIR_NPM" ]]; then
    npm init -y --silent > /dev/null 2>&1 || true
    npm install "$PACKAGE${VERSION:+@$VERSION}" --package-lock-only --silent 2>/dev/null || true
    if npm audit --json > "$REPORT_DIR/npm-audit.json" 2>&1; then
      pass "Layer 1 (npm audit)"
    else
      VULNS=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/npm-audit.json')); print(d.get('metadata',{}).get('vulnerabilities',{}).get('high',0) + d.get('metadata',{}).get('vulnerabilities',{}).get('critical',0))" 2>/dev/null || echo "0")
      if [[ "$VULNS" == "0" ]]; then
        pass "Layer 1 (npm audit — no high/critical)"
      else
        fail "Layer 1 (npm audit) — $VULNS high/critical vulnerabilities"
      fi
    fi
    cd - > /dev/null 2>&1 || true
    rm -rf "$TMPDIR_NPM" 2>/dev/null || true
    fi
  fi
fi

# ── Layer 2: Malware Scan ────────────────────────────────────────────────────
log "=== Layer 2: Malware Scan ==="
if command -v guarddog &>/dev/null; then
  if $DRY_RUN; then
    log "Would run: guarddog $ECOSYSTEM scan $PACKAGE"
  else
    GDARGS="$ECOSYSTEM scan $PACKAGE"
    [[ -n "$VERSION" ]] && GDARGS="$GDARGS --version $VERSION"
    if guarddog $GDARGS --output-format=json > "$REPORT_DIR/guarddog.json" 2>&1; then
      pass "Layer 2 (guarddog)"
    else
      fail "Layer 2 (guarddog) — suspicious patterns detected"
    fi
  fi
else
  skip "Layer 2 (guarddog)"
fi

# ── Layer 3: Static Analysis ────────────────────────────────────────────────
log "=== Layer 3: Static Analysis ==="
if command -v semgrep &>/dev/null; then
  if $DRY_RUN; then
    log "Would run: semgrep --config=auto on downloaded package"
  else
    # Download package source for scanning
    SCAN_DIR=$(mktemp -d)
    if [[ "$ECOSYSTEM" == "pypi" ]]; then
      pip3 download --no-deps --no-binary :all: -d "$SCAN_DIR" "$PACKAGE${VERSION:+==$VERSION}" 2>/dev/null || \
      pip3 download --no-deps -d "$SCAN_DIR" "$PACKAGE${VERSION:+==$VERSION}" 2>/dev/null || true
      # Extract if tarball/wheel
      for f in "$SCAN_DIR"/*.tar.gz "$SCAN_DIR"/*.whl "$SCAN_DIR"/*.zip; do
        [[ -f "$f" ]] && python3 -c "
import tarfile, zipfile, sys
f='$f'
if f.endswith('.tar.gz'): tarfile.open(f).extractall('$SCAN_DIR/src')
elif f.endswith(('.whl','.zip')):
  import zipfile; zipfile.ZipFile(f).extractall('$SCAN_DIR/src')
" 2>/dev/null || true
      done
      SCAN_TARGET="$SCAN_DIR/src"
    elif [[ "$ECOSYSTEM" == "npm" ]]; then
      SCAN_TARGET=$(mktemp -d)
      npm pack "$PACKAGE${VERSION:+@$VERSION}" --pack-destination "$SCAN_TARGET" 2>/dev/null || true
      for f in "$SCAN_TARGET"/*.tgz; do
        [[ -f "$f" ]] && tar xzf "$f" -C "$SCAN_TARGET" 2>/dev/null || true
      done
    fi

    if [[ -d "${SCAN_TARGET:-}" ]] && [[ "$(find "${SCAN_TARGET}" -name '*.py' -o -name '*.js' -o -name '*.ts' 2>/dev/null | head -1)" ]]; then
      if semgrep --config=auto "$SCAN_TARGET" --json --quiet > "$REPORT_DIR/semgrep.json" 2>/dev/null; then
        # Only count SECURITY-relevant ERROR findings. --config=auto also emits
        # non-security categories (compatibility/best-practice/maintainability) —
        # e.g. a Python 3.7 compat lint — which must NOT fail a security gate
        # (false-positived legitimate tools like semgrep itself, 2026-06-01).
        ERRORS=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/semgrep.json')); skip=('compatibility','best-practice','best_practice','maintainability'); print(sum(1 for r in d.get('results',[]) if r.get('extra',{}).get('severity','')=='ERROR' and not any(s in r.get('check_id','') for s in skip)))" 2>/dev/null || echo "0")
        if [[ "$ERRORS" == "0" ]]; then
          pass "Layer 3 (semgrep — 0 security-relevant ERROR findings)"
        else
          fail "Layer 3 (semgrep) — $ERRORS security-relevant ERROR-level findings"
        fi
      else
        pass "Layer 3 (semgrep — scan completed)"
      fi
    else
      skip "Layer 3a (semgrep — no source files found to scan)"
    fi

    # Layer 3b: bandit (Python only)
    if [[ "$ECOSYSTEM" == "pypi" ]] && command -v bandit &>/dev/null; then
      if [[ -d "${SCAN_TARGET:-}" ]]; then
        BANDIT_ERRORS=$(bandit -r "$SCAN_TARGET" -f json -ll 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([r for r in d.get('results',[]) if r.get('issue_severity','') in ('HIGH','MEDIUM')]))" 2>/dev/null || echo "0")
        if [[ "$BANDIT_ERRORS" == "0" ]]; then
          pass "Layer 3b (bandit — 0 HIGH/MEDIUM findings)"
        else
          fail "Layer 3b (bandit) — $BANDIT_ERRORS HIGH/MEDIUM findings"
        fi
      fi
    fi

    rm -rf "$SCAN_DIR" "${SCAN_TARGET:-}" 2>/dev/null || true
  fi
else
  skip "Layer 3 (semgrep)"
fi

# ── Layer 4: Agent-Specific ──────────────────────────────────────────────────
# agent-specific risks generic scanners miss: prompt-injection, exec/shell abuse,
# data-exfiltration, credential access, self-modification. Ships in-tree as
# bus/agent-audit-kit.py (stdlib-only); also runnable via an installed CLI.
log "=== Layer 4: Agent-Specific ==="
AAK_LOCAL="${SCRIPT_DIR}/agent-audit-kit.py"
if command -v agent-audit-kit &>/dev/null; then
  AAK_CMD=(agent-audit-kit)
elif [[ -f "$AAK_LOCAL" ]]; then
  AAK_CMD=(python3 "$AAK_LOCAL")
else
  AAK_CMD=()
fi

if [[ ${#AAK_CMD[@]} -eq 0 ]]; then
  skip "Layer 4 (agent-audit-kit)"
elif $DRY_RUN; then
  log "Would run: ${AAK_CMD[*]} scan <downloaded package> --json --min-severity medium"
else
  # Download + extract the package source (mirrors Layer 3; Layer 3 cleans up its
  # own SCAN_TARGET, so Layer 4 fetches independently).
  AAK_DIR=$(mktemp -d)
  AAK_TARGET=""
  if [[ "$ECOSYSTEM" == "pypi" ]]; then
    pip3 download --no-deps --no-binary :all: -d "$AAK_DIR" "$PACKAGE${VERSION:+==$VERSION}" 2>/dev/null || \
    pip3 download --no-deps -d "$AAK_DIR" "$PACKAGE${VERSION:+==$VERSION}" 2>/dev/null || true
    for f in "$AAK_DIR"/*.tar.gz "$AAK_DIR"/*.whl "$AAK_DIR"/*.zip; do
      [[ -f "$f" ]] && python3 -c "
import tarfile, zipfile
f='$f'
if f.endswith('.tar.gz'): tarfile.open(f).extractall('$AAK_DIR/src')
elif f.endswith(('.whl','.zip')): zipfile.ZipFile(f).extractall('$AAK_DIR/src')
" 2>/dev/null || true
    done
    AAK_TARGET="$AAK_DIR/src"
  elif [[ "$ECOSYSTEM" == "npm" ]]; then
    npm pack "$PACKAGE${VERSION:+@$VERSION}" --pack-destination "$AAK_DIR" 2>/dev/null || true
    for f in "$AAK_DIR"/*.tgz; do
      [[ -f "$f" ]] && tar xzf "$f" -C "$AAK_DIR" 2>/dev/null || true
    done
    AAK_TARGET="$AAK_DIR"
  elif [[ "$ECOSYSTEM" == "github" ]]; then
    git clone --depth 1 "https://github.com/$PACKAGE" "$AAK_DIR/src" 2>/dev/null || true
    AAK_TARGET="$AAK_DIR/src"
  fi

  if [[ -d "${AAK_TARGET:-}" ]] && [[ -n "$(find "$AAK_TARGET" -type f 2>/dev/null | head -1)" ]]; then
    # Gate on MEDIUM+ (low = informational, e.g. a literal subprocess call — must
    # not fail a security gate, same principle as Layer 3's category filtering).
    if "${AAK_CMD[@]}" scan "$AAK_TARGET" --json --min-severity medium > "$REPORT_DIR/agent-audit-kit.json" 2>/dev/null; then
      pass "Layer 4 (agent-audit-kit — 0 medium+ agent-specific findings)"
    else
      AAK_N=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/agent-audit-kit.json')); print(d.get('summary',{}).get('total_findings',0))" 2>/dev/null || echo "?")
      AAK_MAX=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/agent-audit-kit.json')); print(d.get('summary',{}).get('max_severity','?'))" 2>/dev/null || echo "?")
      fail "Layer 4 (agent-audit-kit) — $AAK_N agent-specific finding(s), max severity $AAK_MAX"
    fi
  else
    skip "Layer 4 (agent-audit-kit — no source files found to scan)"
  fi
  rm -rf "$AAK_DIR" 2>/dev/null || true
fi

# ── Layer 5: Repo Health ────────────────────────────────────────────────────
log "=== Layer 5: Repo Health ==="
# scorecard rate-limits / hangs without a GitHub token. Source one from gh CLI
# (or an existing env var) so Layer 5 actually runs instead of stalling.
export GITHUB_AUTH_TOKEN="${GITHUB_AUTH_TOKEN:-${GITHUB_TOKEN:-$(gh auth token 2>/dev/null)}}"
if command -v scorecard &>/dev/null; then
  if [[ "$ECOSYSTEM" == "github" ]]; then
    REPO_URL="https://github.com/$PACKAGE"
  else
    # Try to resolve PyPI/npm to GitHub
    REPO_URL=""
  fi
  if [[ -n "$REPO_URL" ]]; then
    if $DRY_RUN; then
      log "Would run: scorecard --repo=$REPO_URL --format json"
    else
      if scorecard --repo="$REPO_URL" --format json > "$REPORT_DIR/scorecard.json" 2>&1; then
        SCORE=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/scorecard.json')); print(d.get('aggregate',{}).get('score',0))" 2>/dev/null || echo "0")
        if python3 -c "exit(0 if float('$SCORE') >= 5.0 else 1)" 2>/dev/null; then
          pass "Layer 5 (scorecard — aggregate $SCORE >= 5.0)"
        else
          fail "Layer 5 (scorecard) — aggregate $SCORE < 5.0"
        fi
      else
        fail "Layer 5 (scorecard) — scan failed"
      fi
    fi
  else
    skip "Layer 5 (scorecard — cannot resolve $ECOSYSTEM package to GitHub repo)"
  fi
else
  skip "Layer 5 (scorecard)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
log "=== SUMMARY ==="
log "Package: $ECOSYSTEM/$PACKAGE${VERSION:+ v$VERSION}"
log "Report: $REPORT_DIR/"
log "Passed: $PASSES | Failed: $FAILURES | Skipped: $SKIPS"

if [[ $FAILURES -gt 0 ]]; then
  log "VERDICT: FAIL — $FAILURES layer(s) found issues"
  exit 1
elif [[ $PASSES -eq 0 ]]; then
  log "VERDICT: INCONCLUSIVE — all layers skipped (no tools installed)"
  exit 2
else
  log "VERDICT: PASS — all available layers passed ($SKIPS skipped)"
  exit 0
fi
