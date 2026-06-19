# ADR-0002: Wire the completion contract into the daemon worker lifecycle

- **Status:** shadow (all flags default OFF; code present on jcv1-deps, no production restart yet)
- **Date:** 2026-06-18
- **Deciders:** Jarvis (proposed), B (approval gate for daemon production change)
- **Related components:** service.daemon, service.run-store, db.runs, flag.FEATURE_COMPLETION_CONTRACT, flag.FEATURE_LEASE_JOIN, flag.FEATURE_TRACE_ID, flag.FEATURE_OUTCOME_HB
- **Related commits:** 6b3f552 (data layer), 827f051 (daemon wiring)

## Problem

The completion-contract feature set (signed CompletionEnvelope, run-store, idempotency, lease/join, trace propagation, outcome heartbeat) was built and unit-tested as CLI verbs and library code, but had **no production call path through the daemon worker lifecycle**. The daemon still treated a bare process exit code 0 as "completed." That is exactly the failure class recorded in INC-2026-06-18: a feature can be fully built, tested, and committed yet never actually run in production because nothing in the live path invokes it. A run could be marked done on a bare exit even though no signed completion envelope was ever emitted.

## Decision

Wire run-creation, IPC completion, lease, trace, and outcome-heartbeat into the daemon worker lifecycle (worker-process exit handler + run-contract.ts), with every new behavior gated behind its feature flag (FEATURE_COMPLETION_CONTRACT, FEATURE_LEASE_JOIN, FEATURE_TRACE_ID, FEATURE_OUTCOME_HB). With flags OFF, behavior is identical to legacy (code 0 = completed). With FEATURE_COMPLETION_CONTRACT ON, a bare process exit is an EVENT, not a state transition: classifyWorkerExit checks the run-store for a valid signed envelope and otherwise leaves the run for the lease sweep to resolve.

## Why

- INC-2026-06-18 proved that "built + tested + committed" is not "live." The only fix that addresses the class is making the daemon actually call the contract (the production call path), and proving it with daemon-level tests, not just unit tests.
- Flag-gating every new behavior keeps the change reversible and lets us run a shadow/parity window before flipping anything on.
- Outcome heartbeat (exit-without-envelope => UNHEALTHY) gives an observable signal during the shadow window so we can see the contract working before it gates anything.

## Alternatives Rejected

- **Keep the contract CLI-only and let agents opt in by calling verbs** — rejected: that is the exact INC-2026-06-18 anti-pattern (no enforced production call path; relies on every caller remembering to invoke it).
- **Restart the daemon with all flags ON immediately** — rejected: no shadow/parity window, no demonstrated rollback under load, violates the release criterion (production-call-path-proven before live). Risks the whole fleet on an unproven path.

## Assumptions

- The run-store (runs.db, WAL) is safe under daemon + CLI concurrent writes — this is why ADR-0001 (better-sqlite3 12.11.1 WAL-reset fix) is a prerequisite for flipping these flags ON.
- Feature-flag reads (src/utils/feature-flags.ts) are cheap enough to call in the worker exit hot path.
- The lease sweep reliably resolves runs left un-envelope'd by a bare exit (covered by lease-join tests).

## Risks

- If a flag is flipped ON before the run-store WAL is proven safe (ADR-0001 merged), a worker exit could race the run-store write. Mitigation: ADR-0001 is a hard prerequisite.
- A bug in classifyWorkerExit could leave legitimate completed runs stuck pending the lease sweep (delayed, not lost). Mitigation: outcome heartbeat surfaces it; flags default OFF.
- Blast radius is the entire fleet's run lifecycle. Mitigation: shadow window, disposable-daemon tests, all flags OFF by default.

## Rollback

```
# fastest: flip all four flags false in feature-flags.json -> legacy behavior restored live, no restart-of-code needed
# full revert:
git revert 827f051 6b3f552
```

With flags OFF the daemon uses the legacy path (code 0 = completed), so rollback does not require reverting code unless the off-path itself regresses.

---

## Gap-closure (reqs 3+4): durable run_events + WorkerFactory + instance flags

- **Commit:** 6db4248 (`feat(daemon): durable run_events + WorkerFactory DI + instance-scoped flags`)
- **Date:** 2026-06-18
- **Status:** shadow (additive; default/production instance leaves the new env seams unset, so the live path is byte-identical to legacy)

### What changed

This closes B's requirements 3 (durable, authoritative terminal/join events instead of structural inference) and 4 (remove the env-var test seam; scope feature flags per instance).

1. **Durable `run_events` table** (`src/bus/run-store.ts`). Additive SQLite table, authoritative source of truth for lifecycle events — no JSONL reliance, no harness event tables. Columns: `event_key TEXT PRIMARY KEY`, `run_id`, `parent_run_id`, `trace_id`, `event_type`, `terminal_state`, `payload_json TEXT NOT NULL DEFAULT '{}'`, `created_at`. Event keys are deterministic, which is what makes inserts idempotent on the PK.

2. **`run_terminal` event.** Inserted by the lease-sweep (`expireStaleRuns`) CAS winner ONLY, in the SAME transaction as the `running -> stalled` `UPDATE ... RETURNING` flip. Idempotent on the PK `terminal:<run_id>:stalled` (`INSERT OR IGNORE`). The CAS loser flips nothing and emits no event, so a real multi-sweeper race yields exactly one transition and exactly one `run_terminal`.

3. **`parent_join_resolved` event.** Emitted by `joinRun` when it FIRST observes the terminal child, in the join transaction. Idempotent on the PK `join-resolved:<parent_run_id>:<child_run_id>:<terminal_state>`. Repeated joins of an already-resolved child create no second event, no side effect, and no second worker.

4. **`BEGIN IMMEDIATE` on the `expireStaleRuns` + `joinRun` transactions only** (`withDb` is unchanged). This fixes a DEFERRED-transaction read->write upgrade that surfaced `SQLITE_BUSY` and was being swallowed as a `null` result. Scoped to those two functions to keep blast radius minimal.

5. **WorkerFactory dependency injection** (`src/pty/agent-pty.ts`, `src/daemon/worker-process.ts`, `src/daemon/agent-manager.ts`). A test-only injected `WorkerFactory` replaces the spawned command in tests. It is `null` on every production call site (`workerFactory ?? null`). This replaces the never-shipped env-var test-seam concept: `dist/daemon.js` has NO env-var test path — `grep CTX_TEST_WORKER_CMD` = 0 and `grep test-worker-factory` = 0 against the built daemon, so there is no arbitrary-exec env seam in production.

6. **Instance-scoped feature flags.** Worker children thread `CTX_FEATURE_FLAGS_PATH` / `CTX_RUN_STORE_DB` from their OWN instance (`src/pty/agent-pty.ts`), so an isolated test instance resolves its own flags/db rather than the production paths. The default/production instance leaves these unset, so behavior is byte-identical to the legacy path.

### Evidence

- **Real concurrent race** (2 sweepers + 2 join callers, separate processes + separate db connections, 50 iterations): exactly one transition / one `run_terminal` / one `parent_join_resolved` per child, idempotent repeats, late completion rejected, 0 db errors, 0 duplicates, against the REAL `run_events` table (no harness tables). Evidence: `state/proof/gate-events-race-evidence-2026-06-18.json`.
- **WorkerFactory + instance flags** (items 5b/5c/6 integration tests pass): `state/proof/gate-seam-flags-evidence-2026-06-18.json`.
- **GATE 1+2** (real daemon process + real worker-spawn path): `state/proof/gate12-daemon-process-evidence-2026-06-18.json`.
- **GATE 4** (clean-env regression + durability): full suite = 16 failures, all pre-existing flaky timing/perf (zero new vs the 16-baseline); WAL 74-writer (3700/3700) + 100-writer (5000/5000) lost=0 busy=0 integrity=ok; revenue smoke read-only clean (options-bot equity $1836.19 unchanged, pre-existing operator halt only); node-pty prebuild exec-bit is an npm-ci-restored artifact verified at cutover.

### Rollback

The new behavior is additive and instance-scoped. The default/production instance never sets `CTX_FEATURE_FLAGS_PATH` / `CTX_RUN_STORE_DB`, and `workerFactory` is `null` in production, so the flags-off legacy path is unaffected. To remove the gap-closure entirely: `git revert 6db4248`. The `run_events` table is additive (`CREATE TABLE IF NOT EXISTS`) and unread by the legacy path, so it is inert if left in place.

## Evidence That Would Reverse

- Daemon canaries or disposable-daemon tests showing a completed run being lost or double-counted under the contract path.
- Outcome-heartbeat data during the shadow window showing legitimate completions classified UNHEALTHY at a rate that does not converge as bugs are fixed.
- run-store WAL corruption under concurrent daemon+CLI load even on better-sqlite3 12.11.1 (would reverse both this and ADR-0001).
