# ADR-0001: Bump better-sqlite3 11.x to 12.11.1 (SQLite 3.49.2 to 3.53.2)

- **Status:** shadow (pinned on branch jcv1-deps; main remains ^11.0.0 pending B approval to merge)
- **Date:** 2026-06-18
- **Deciders:** Jarvis (proposed), B (approval gate for production dependency change)
- **Related components:** lib.better-sqlite3, db.runs, db.sessions, db.claims, db.source_log, db.halt_state
- **Related commits:** 5788e1f

## Problem

cortextOS pins `better-sqlite3` at `^11.0.0`, which resolves to 11.10.0 bundling SQLite 3.49.2. SQLite 3.49.2 carries an unpatched WAL-reset race: under concurrent WAL access (multiple readers/writers across the daemon worker + CLI writers of runs.db), the WAL reset path can corrupt or lose committed frames. The completion-contract / run-store work (ADR-0002) makes runs.db a multi-writer WAL database in the hot path of the daemon worker lifecycle, which raises the exposure from theoretical to load-bearing.

## Decision

Pin `better-sqlite3` to exactly `12.11.1`, which bundles SQLite 3.53.2 with the WAL-reset race patched. This is an isolated dependency change with no daemon code changes in the same commit (commit 5788e1f).

## Why

- The WAL-reset race is in the storage layer every cortextOS SQLite DB depends on, so the fix benefits all five databases, not just runs.db.
- 12.11.1 is a clean, current pin (SQLite 3.53.2) rather than chasing a backport.
- Validated with a WAL stress test and a parse test against a real-DB copy (no schema or query incompatibility observed).
- Keeping it isolated (no daemon changes) makes the rollback a pure dependency revert.

## Alternatives Rejected

- **Backport just the SQLite patch onto 11.10.0** — rejected: requires maintaining a forked native build, more fragile than tracking the upstream pin, and no compensating benefit.
- **Stay on 11.10.0 and serialize all WAL access in app code** — rejected: pushes a storage-engine bug into application-level locking, increases contention, and does not actually fix the race for the discordbot/hooks DBs that cortextOS does not control the access pattern of.

## Assumptions

- 12.11.1 is API-compatible with cortextOS's better-sqlite3 usage (validated against real-DB copy; no breaking call observed).
- Native addon rebuilds cleanly on the Mac Mini M4 / current Node version (validated by the build in 5788e1f's tree).

## Risks

- Native-module ABI mismatch if Node version changes without `npm ci` rebuild.
- A regression in 12.11.1 unrelated to the WAL fix (mitigated by the isolated, easily-reverted change and shadow window before merge to main).

## Rollback

```
# revert the dependency pin
git revert 5788e1f
npm ci          # rebuilds native addon back to 11.10.0 (SQLite 3.49.2)
```

The change is isolated to package.json + lockfile; no daemon code depends on 12-specific behavior, so revert is clean.

## Evidence That Would Reverse

- A reproducible read/write failure or data corruption on any of the five DBs after the bump that does not occur on 11.10.0.
- A native build failure on the production Node version that cannot be resolved with `npm ci`.
- Discovery that the WAL-reset race does not actually affect cortextOS's access pattern (would downgrade the urgency, not necessarily revert, but would remove the justification for forcing it).
