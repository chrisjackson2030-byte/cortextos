# ADR-0003: A feature is not "live" until a production call path is proven

- **Status:** accepted (permanent release rule)
- **Date:** 2026-06-18
- **Deciders:** B (directive), Jarvis
- **Related components:** guard.feature-reachability, service.daemon, all feature_flag components
- **Related commits:** c99ed3f (feature-reachability guard), 827f051 / 6b3f552 (ADR-0002 the triggering work)

## Problem

INC-2026-06-18: features (the completion contract set) were fully built, unit-tested, and committed, yet had no call path through the daemon — they could not run in production no matter how the flags were set, because nothing in the live worker lifecycle invoked them. The system could honestly report "feature built and tested" while the feature was, in production, dead code. This is a class of fabrication-by-omission: the claim "it works" was true in tests and false in production. The root cause is treating "merged" as equivalent to "live."

## Decision

A change is **not complete and not live** until a production call path is proven to reach it. Concretely, before a feature may be called live (its flag flipped ON in production):

1. There is a demonstrated production call path (a real daemon / CLI / cron / hook invocation reaches the code, shown by a daemon-level or end-to-end test, not only a unit test).
2. The feature-reachability guard (src/utils/feature-reachability.ts) classifies the flag's call sites as reachable from a production entry point.
3. The release criterion in RULES.md (registry updated, decision record updated, impact report passes, old-path status recorded, tests + canary pass, rollback demonstrated, runtime reconciliation confirms documented == reality) is satisfied.

"Built + tested + committed" is explicitly NOT sufficient.

## Why

- It is the direct, class-level fix for INC-2026-06-18: the only thing that prevents "built but dead in prod" is requiring proof of the live call path.
- A static guard (feature-reachability) catches the regression mechanically rather than relying on judgment under load.
- It composes with the completion contract: the contract proves a run finished; this rule proves the feature was ever reachable to run.

## Alternatives Rejected

- **Trust code review to catch unreachable features** — rejected: INC-2026-06-18 passed review; humans/agents under load miss reachability. Needs a mechanized guard.
- **Only require unit tests** — rejected: unit tests pass on unreachable code, which is exactly how the incident happened.

## Assumptions

- Every production-callable feature is gated by an isFeatureEnabled('FLAG') site the reachability scanner can find (the convention the guard depends on).
- Daemon-level / disposable-daemon tests can exercise the real call path cheaply enough to run per release.

## Risks

- A feature invoked through a path the scanner cannot statically see (dynamic dispatch, string-built flag names) could be misclassified as unreachable. Mitigation: keep flag checks literal; the scanner tolerates whitespace but expects literal flag strings.
- The rule adds release friction. Accepted: the friction is the point; it is cheaper than shipping dead code that claims to work.

## Rollback

This is a process rule, not running code. To roll back the mechanized portion:

```
git revert c99ed3f   # removes the feature-reachability guard
```

The release-criterion rule itself is documented in RULES.md and is a permanent B directive; it is not reverted by code.

## Evidence That Would Reverse

- The guard producing false-unreachable verdicts at a rate that blocks legitimate releases and cannot be fixed by tightening the flag-check convention.
- A demonstrated case where requiring a proven call path materially harmed delivery without preventing any real incident (none expected; INC-2026-06-18 is the standing counter-evidence).
