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

## Evidence That Would Reverse

- Daemon canaries or disposable-daemon tests showing a completed run being lost or double-counted under the contract path.
- Outcome-heartbeat data during the shadow window showing legitimate completions classified UNHEALTHY at a rate that does not converge as bugs are fixed.
- run-store WAL corruption under concurrent daemon+CLI load even on better-sqlite3 12.11.1 (would reverse both this and ADR-0001).
