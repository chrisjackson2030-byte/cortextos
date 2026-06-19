# ADR-0004: Every executable component declares an exit-code contract; nonzero != failure by default

- **Status:** accepted (permanent registry rule)
- **Date:** 2026-06-18
- **Deciders:** B (directive), Jarvis
- **Related components:** watchdog.reconciler, all executable components (agent / service / watchdog / launchd_job / sidecar), src/utils/exit-code-classifier.ts
- **Related incident:** INC-2026-06-18-reconciler-exit2-misread

## Problem

ai.jarvis.reconciler (desired-state-reconciler.py) was classified as "failing" because its launchctl `LastExitStatus` was 512 (exit code 2). That was a misread. Exit 2 is a SEMANTIC success-with-action code in that script: it means "drift detected and at least one corrective action was taken." The reconciler exits 2 by design on every productive run that fixes drift; treating any nonzero exit as a failure mislabeled a healthy, working control loop as broken.

Verified evidence:
- `desired-state-reconciler.py:16` (module docstring): "Exit codes: 0=clean/no drift, 1=internal error, 2=drift detected and at least one action taken."
- `desired-state-reconciler.py:544` (`reconcile_once` docstring): "One full reconcile pass. Exit code: 0=clean, 1=error, 2=drift-fixed."
- `desired-state-reconciler.py:631`: `return 2 if any_fixed else 0`.
- `desired-state-reconciler.py:640`: `print(f"[reconciler] exit={rc} ({'clean' if rc==0 else 'drift-fixed' if rc==2 else 'error'})")`.
- launchd contract `ai.jarvis.reconciler.plist`: ProgramArguments = `/opt/homebrew/bin/python3 .../desired-state-reconciler.py --once`; `StartInterval` = 300.
- `launchctl list ai.jarvis.reconciler` -> `LastExitStatus = 512` (= exit code 2).
- `~/.cortextos/logs/reconciler.err.log` size = 0 bytes (no error output).
- `~/.cortextos/logs/reconciler.out.log` tail: `[reconciler] exit=2 (drift-fixed)`; file mtime 2026-06-18 18:06 ET = last_productive_run.

The root cause is that the registry recorded no exit-code contract, so a reader defaulted to "nonzero = failure."

## Decision

1. Every executable component (a process / script / cron / launchd job / daemon) in `system-model/components.json` carries an exit-code contract: `success_exit_codes`, `warning_exit_codes`, `failure_exit_codes`, `exit_code_meanings`, plus `last_exit_code`, `last_productive_run`, `last_verified_status`.
2. A nonzero exit code is classified a **failure only if `failure_exit_codes` contains it.** Codes in `success_exit_codes` or `warning_exit_codes` are not failures regardless of being nonzero. A code in none of the three declared sets is `unknown` (investigate, do not assume-failed).
3. The reconciler's contract is `success=[0]`, `warning=[2]` (drift-fixed), `failure=[1]` (error), and its registry status is corrected from `unknown` to `active`/healthy.
4. Where a component's exit-code contract is not verifiable (claude-code interactive agent processes, in-process subsystems, unknown launchd jobs), the codes are `null` and `last_verified_status` reflects that, rather than inventing codes (RULES.md rule 8).

This is enforced mechanically by `classifyExitCode(record, code)` (src/utils/exit-code-classifier.ts) and a regression test (tests/unit/registry-exit-code-classification.test.ts).

## Why

- It is the class-level fix: the only thing that prevents "healthy nonzero exit read as failure" is requiring each component to declare which codes actually mean failure.
- A pure helper + test makes the classification mechanical, not judgment-under-load.
- It respects zero-fabrication: unverifiable contracts are `null`/`unknown`, never invented.

## Alternatives Rejected

- **Default nonzero = failure** — rejected: that is the exact bug. Many tools use nonzero codes for semantic non-error states (2 = drift-fixed here, like `grep`/`rsync`/`git` conventions).
- **Special-case the reconciler only** — rejected: the misread is a class. Every executable component needs a declared contract so the class can't recur.
- **Infer contracts for all components from source** — rejected where unverifiable: claude-code agent processes and in-process subsystems have no standalone exit-code contract to read; inventing one would be fabrication.

## Assumptions

- The reconciler's exit-code semantics (0/1/2) are stable; they are documented in two docstrings and the return statement, all consistent.
- launchctl `LastExitStatus` is `code << 8` for normal exits (512 = exit 2), as observed.

## Risks

- A component could change its exit-code semantics without updating the registry. Mitigated by RULES.md rule 7 (registry updates in the same change as code) and the nightly reconciliation comparing documented vs reality.

## Rollback

`git revert <this commit>` on jcv1-deps. Additive registry fields + a new pure helper + a new test + doc edits; no runtime/daemon/production behavior changes. The live checkout and production launchd jobs are untouched (the reconciler plist and script were read-only this change).
