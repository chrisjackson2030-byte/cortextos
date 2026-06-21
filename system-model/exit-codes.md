# Exit-Code Contracts

Per ADR-0004: every executable component declares an exit-code contract; a nonzero exit is a FAILURE only if the component's `failure_exit_codes` contains it. Codes in `success_exit_codes` or `warning_exit_codes` are not failures regardless of being nonzero. A code in none of the three declared sets is `unknown` (investigate, do not assume-failed). Enforced mechanically by `src/utils/exit-code-classifier.ts` (`classifyExitCode(record, code)`), with regression test `tests/unit/registry-exit-code-classification.test.ts`.

Generated 2026-06-21 from `components.json`. The contract fields live on each component record; this file is the human-readable rollup.

## The one semantic code that matters most

**`ai.jarvis.reconciler` (desired-state-reconciler.py) exit 2 = drift-fixed = HEALTHY, not a failure.** This is the INC-2026-06-18 misread that ADR-0004 fixed. launchctl reports `LastExitStatus = 512` for exit code 2 (`code << 8`). Verified in source: `desired-state-reconciler.py:631 return 2 if any_fixed else 0`. Treating that nonzero as failure mislabeled a healthy control loop as broken.

## Contracts

| Component | success | warning | failure | meanings |
|---|---|---|---|---|
| `watchdog.reconciler` (desired-state-reconciler.py) | `0` | `2` | `1` | 0=clean/no drift, 1=internal error, **2=drift detected and at least one corrective action taken (success-with-action)** |
| `service.daemon` (com.cortextos.daemon) | `0` | (none) | `1` | POSIX convention; 0 verified via launchctl LastExitStatus, 1 not independently verified per-job |
| `launchd.daemon` (com.cortextos.daemon plist) | `0` | (none) | `1` | POSIX convention; same as above |
| `service.codex-fallback` (codex-fallback.sh) | `0` | (none) | `1` | POSIX convention |
| `watchdog.loop-watchdog` | `0` | (none) | `1` | POSIX convention |
| `watchdog.security-monitor` | `0` | (none) | `1` | POSIX convention |

## Declared-null (no standalone exit-code contract verified)

These components have `success/warning/failure = null` and `last_verified_status = "active-no-exit-contract"` because they have no standalone process-exit-code contract to read (claude-code interactive agent processes, in-process subsystems, or unknown). Inventing a contract for them would be fabrication (RULES.md rule 8). Per ADR-0004, their codes stay `null` until verifiable:

- `agent.jarvis`, `agent.nova`, `agent.forge`, `agent.hermes`, `agent.friday`, `agent.atlas` (claude-code / codex interactive processes)
- `service.cron-scheduler`, `service.fast-checker`, `service.run-store`, `guard.feature-reachability` (in-process subsystems of the daemon)
- `launchd.fleet-jobs-registry-note` (the ~110-job class; per-job contracts not enumerated)

## New executables documented this pass (Phase 2)

| Executable | success | warning | failure | meanings | verified |
|---|---|---|---|---|---|
| `tools/ack_protocol_check.py` (Jarvis ack-protocol linter) | `0` | `3` | `1` | 0=OK (clean / promise carries an id / factual), **3=FLAG (commitment phrase, no tracked id) advisory**, 1=usage/runtime error | yes — `tools/test_ack_protocol_check.py` (12 tests pass; CLI exit 3 on bare "on it", 0 on "on it, task_id=...", 0 on factual) |
| `topstep-notifier.py` (once-per-day dedup notifier) | unknown (launchctl LastExitStatus not pulled this pass) | unknown | unknown | dedup is persisted in the cursor JSON; exit-code contract not independently verified | partial — dedup logic + plist (StartInterval 60s) verified on disk; exit codes not pulled |

Exit codes for any launchd executable are read via `launchctl list <label>` (the `LastExitStatus` field is `code << 8`). The nightly reconciliation is the mechanism that fills the `unknown` exit contracts over time; do not invent them.
