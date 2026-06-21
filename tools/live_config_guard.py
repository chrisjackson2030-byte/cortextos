#!/usr/bin/env python3
"""
live_config_guard.py - Protect live production config from direct agent writes.

PURPOSE
  Jarvis (or any agent / cron / nightly self-update) must NOT directly write
  protected live config: feature-flags, live crons, credentials, money / risk /
  trading settings, live prompts, permissions. Those classes only change through
  the reviewed release flow (a release record + checklist + canary + human
  approval where required). This guard is the mechanical enforcement of that.

WHAT IT DOES
  Given a target path (the file an agent wants to write), the guard:
    1. Classifies it against the PROTECTED_PATTERNS table.
    2. If it matches a protected class, the write is BLOCKED unless an explicit
       release-flow authorization token is present (env RELEASE_FLOW_AUTHORIZED
       set to an approved release_id whose record exists and is human-approved).
    3. Returns a decision: ALLOW or BLOCK, with the matched class and reason.

  This is a guard / detector, NOT a file writer. It never applies a change. It
  is meant to be called by any write path (pre-commit hook, agent wrapper, the
  proposer's self-check) before a protected write is attempted, and by the test
  suite to prove protected paths are flagged.

EXIT CODES
  0  ALLOW  (path is not protected, OR is protected and properly authorized)
  3  BLOCK  (protected path, no valid release-flow authorization)
  2  usage / internal error

The BLOCK exit code is intentionally distinct (3) so callers can tell a policy
block apart from a crash.
"""

import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Protected classes. Each entry: class name -> list of glob patterns (matched
# against the path relative to repo root AND the absolute path's tail, so the
# guard works whether callers pass absolute or relative paths).
# These map directly onto the "NOT ALLOWED tonight" / human-approval categories.
PROTECTED_PATTERNS = {
    "feature-flags": [
        "**/feature-flags.json",
        "**/feature-flags*.json",
        "**/jarvis-core/feature-flags.json",
    ],
    "live-crons": [
        "**/agents/*/config.json",          # daemon crons array lives here
        "**/config.json",
    ],
    "credentials": [
        "**/.env",
        "**/.env.*",
        "**/secrets*.json",
        "**/credentials*.json",
        "**/*.key",
        "**/*.pem",
    ],
    "money-risk-trading": [
        "**/risk*.json",
        "**/risk*.yaml",
        "**/risk*.yml",
        "**/*risk-settings*",
        "**/*position-sizing*",
        "**/*trading-config*",
        "**/*money*config*",
        "**/strategies/*/live*.json",
    ],
    "live-prompts": [
        "**/IDENTITY.md",
        "**/SOUL.md",
        "**/GUARDRAILS.md",
        "**/system-prompt*.md",
        "**/live-prompt*.md",
    ],
    "permissions": [
        "**/settings.json",
        "**/settings.local.json",
        "**/permissions*.json",
        "**/.claude/settings*.json",
    ],
}

# config.json is a special case: it is "live-crons" class, but the guard should
# not block reading the repo's own non-cron JSON. We only protect agent config
# that actually carries crons. Keep the pattern broad but documented; a false
# positive here is the SAFE direction (block, force release flow).


def _normalize(target: str) -> tuple[str, str]:
    """Return (relative_to_repo_if_possible, absolute) posix strings."""
    p = Path(target)
    absolute = (p if p.is_absolute() else (Path.cwd() / p)).resolve()
    try:
        rel = absolute.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel = absolute.as_posix()
    return rel, absolute.as_posix()


def classify(target: str) -> str | None:
    """Return the protected class name for a path, or None if not protected."""
    rel, absolute = _normalize(target)
    candidates = {rel, absolute, Path(absolute).name}
    for klass, patterns in PROTECTED_PATTERNS.items():
        for pat in patterns:
            for cand in candidates:
                if fnmatch.fnmatch(cand, pat):
                    return klass
    return None


def _authorized_for(release_id: str | None) -> tuple[bool, str]:
    """
    A protected write is only allowed inside the release flow. We require:
      - env RELEASE_FLOW_AUTHORIZED == a release_id
      - a release record exists at releases/records/<release_id>.json
      - that record's `human_approved` is true
    This makes the ONLY path to a protected write an explicit, human-approved
    release record. There is no autonomous path.
    """
    token = os.environ.get("RELEASE_FLOW_AUTHORIZED", "").strip()
    if not token:
        return False, "no RELEASE_FLOW_AUTHORIZED token in environment"
    if release_id and token != release_id:
        return False, f"token {token!r} does not match release_id {release_id!r}"
    record_path = REPO_ROOT / "releases" / "records" / f"{token}.json"
    if not record_path.exists():
        return False, f"no release record at {record_path}"
    try:
        rec = json.loads(record_path.read_text())
    except Exception as e:  # noqa: BLE001
        return False, f"release record unreadable: {e}"
    if not rec.get("human_approved", False):
        return False, f"release record {token} is not human_approved"
    return True, f"authorized by human-approved release record {token}"


def check(target: str, release_id: str | None = None) -> dict:
    klass = classify(target)
    if klass is None:
        return {"decision": "ALLOW", "protected_class": None,
                "reason": "path is not a protected live-config class"}
    authorized, why = _authorized_for(release_id)
    if authorized:
        return {"decision": "ALLOW", "protected_class": klass,
                "reason": f"protected ({klass}) but {why}"}
    return {"decision": "BLOCK", "protected_class": klass,
            "reason": f"protected live-config class '{klass}': direct agent "
                      f"write is forbidden outside the release flow ({why})"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Guard protected live config from direct agent writes.")
    ap.add_argument("path", help="the file path an agent intends to write")
    ap.add_argument("--release-id", default=None,
                    help="release_id claiming authorization (must match RELEASE_FLOW_AUTHORIZED + a human-approved record)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args(argv)

    result = check(args.path, args.release_id)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['decision']}: {result['reason']}")
    return 0 if result["decision"] == "ALLOW" else 3


if __name__ == "__main__":
    sys.exit(main())
