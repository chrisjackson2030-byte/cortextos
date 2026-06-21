# Jarvis System Model + Change-Impact Gate — RULES

Permanent Jarvis Core requirement. These rules govern every change Jarvis (or any agent/cron/nightly self-update under Jarvis) makes to the system. They are not advisory. A change that violates them is not complete and must not go live.

---

## The 10 Permanent Rules

1. **Capability-search-before-build.** Before building anything, search the registry (and the wider ecosystem per the GitHub-probe directive) for an existing capability that already does it. Adopt or extend before creating new.

2. **One named primary owner per capability.** Every capability has exactly one `primary_owner` recorded in `capabilities.json`. No capability is ownerless or co-owned.

3. **One named source of truth per fact.** Every fact (a balance, a status, a runtime, a schedule) has exactly one named `source_of_truth`. Read the source; never treat a cache, snapshot, or prose summary as truth.

4. **No replacement without naming the old + its retirement condition.** You may not introduce a new implementation of an existing capability without naming the implementation it replaces AND the explicit condition under which the old one is retired.

5. **Old and new coexist only in a documented shadow/parity window.** When old and new run side by side, that window is explicitly documented (status=shadow), time- or evidence-bounded, with a parity check. No indefinite silent coexistence.

6. **Migration is incomplete until the old is retired-or-justified-retained.** A migration is not done while the old path still runs unrecorded. Either retire the old path or record an explicit, justified decision to retain it.

7. **Registry + deps + ADR + tests + rollback update in the SAME change as the code.** A code change that touches the system landscape MUST update `components.json`, `dependencies.json`, the relevant ADR, tests, and the rollback plan in the same change. Documentation does not lag code.

8. **No claim-to-understand / repair / replace an unknown component.** Jarvis may not claim to understand, repair, or replace a component it has not verified. Unknown components are marked `status="unknown"` and are not acted on as if understood.

9. **Unknown triggers investigation before modification.** Encountering an unknown component triggers an investigation step BEFORE any modification. You investigate to known-state first, then change.

10. **No nightly self-update creates new infrastructure without the change-impact gate.** No nightly/autonomous self-update may create a new service, cron, agent, database, permission, credential, or external action without passing the CHANGE-IMPACT REPORT gate below. The nightly reconciliation is PROPOSE-ONLY (see below); it never silently creates or deletes production.

11. **An acknowledgement is not completion. A promise to work requires a tracked object.** (B directive, 2026-06-21.) Acking a request ("on it", "working on it", "I will...") is not the same as doing it, and is not the same as completing it. Any outbound message that PROMISES future work must be backed by a tracked object: a `task_id`, a `run_id`, or a `commitment_id`. A bare promise with no tracked object is a discipline failure because the work has no durable handle and can silently vanish. This rule is encoded in the Jarvis comms policy (GUARDRAILS.md WS3) and checked advisorily by `tools/ack_protocol_check.py` (see ENFORCEMENT below).

---

## ENFORCEMENT RULES (point-of-action gates)

These convert the 11 rules into concrete, fire-at-decision-time gates. They are not separate from the rules; they are how the rules are enforced.

- **No new component without a capability search.** (Rule 1.) Before creating any component, search `capabilities.json` and the wider ecosystem for an existing owner. The CHANGE-IMPACT REPORT's `duplicate_capability_check.searched` must be `true` and record the result. A `build-new` decision when an existing owner was found is gate-blocked unless explicitly justified.

- **No replacement without an old-path retirement condition.** (Rules 4 to 6.) You may not introduce a new implementation of an existing capability without naming the `replaces` component AND the explicit `retirement_condition` for the old path. A migration with the old path still running unrecorded is incomplete.

- **No "live" claim without a production-call-path proof.** (Rule release criterion 1, ADR-0003, INC-2026-06-18.) A component or feature may not be marked `active`/live in the registry until a real production entry point (daemon / CLI / cron / hook) is demonstrably reached. Feature flags being `true` in `feature-flags.json` is necessary but not sufficient; the reachability guard (`src/utils/feature-reachability.ts`) plus a daemon-level or end-to-end test is the proof.

- **No unknown component modified without investigation.** (Rules 8 to 9.) A component at `status="unknown"` is investigated to known-state BEFORE any modification. You never claim to understand, repair, or replace an unknown component.

- **Nightly reconciliation is read-only and propose-only.** (Rule 10.) The nightly desired-state / registry reconciliation compares documented vs reality and emits PROPOSE-ONLY records. It never auto-creates, auto-deletes, or auto-rewrites production ownership. Live mutation requires a passed CHANGE-IMPACT REPORT (and, where the action-gradient requires, B approval).

- **A promise needs a tracked object.** (Rule 11.) Run `tools/ack_protocol_check.py` advisorily on any outbound B-message that contains a future-work phrase. If it flags (commitment phrase, no `task_id`/`run_id`/`commitment_id`), attach a tracked object before the promise is treated as real work. Advisory, not a hard block.

---

## CHANGE-IMPACT REPORT (machine-readable format)

Every change that creates/modifies/retires a component, capability, schedule, DB, credential, permission, or external action MUST produce this report and pass it before going live. Emit as JSON.

```json
{
  "change_id": "string",
  "summary": "one line",
  "components_touched": ["component_id", "..."],
  "capabilities_affected": ["capability", "..."],
  "upstream_deps": ["component_id this change depends on"],
  "downstream_dependents": ["component_id that depends on what this change touches"],
  "schedules_affected": ["cron/launchd job ids"],
  "dbs_and_files_affected": ["db id or file path"],
  "credentials_and_permissions": {
    "credentials_used": ["keychain names (never values)"],
    "permissions_required": ["..."],
    "new_or_escalated": true
  },
  "external_side_effects": ["telegram", "shopify", "live-order", "..."],
  "revenue_or_trading_impact": {
    "affected_lanes": ["trading.alpaca-options", "revenue.shopify-quiet-kiln", "..."],
    "money_at_risk": "none | <amount> | unknown",
    "irreversible": false
  },
  "duplicate_capability_check": {
    "searched": true,
    "existing_owner_found": "capability + primary_owner, or null",
    "decision": "adopt | extend | build-new (justified)"
  },
  "replacement_and_retirement_plan": {
    "replaces": "component_id or null",
    "retirement_condition": "explicit condition or 'n/a'",
    "shadow_parity_window": "duration/criteria or 'n/a'"
  },
  "tests": ["test path/name proving the change"],
  "canary": "canary plan or result",
  "rollback": "exact steps to undo (commands/flags/reverts)"
}
```

A change is gate-blocked if: duplicate_capability_check found an existing owner and decision is unjustified build-new; OR credentials_and_permissions.new_or_escalated is true without explicit approval; OR external_side_effects/irreversible/money_at_risk trips the action-gradient ask-first threshold without B approval; OR tests/rollback are absent.

---

## NIGHTLY READ-ONLY RECONCILIATION (spec)

A nightly job compares the registry against live reality and PROPOSES corrections. It is strictly read-only: it never silently redesigns, creates, or deletes production.

**Compares registry vs:**
- `launchctl list` (loaded launchd jobs) — vs launchd_job components
- daemon crons (config.json crons array) — vs schedules in components
- running processes (ps / launchctl pids) — vs runtime_process fields
- feature-flags.json — vs feature_flag component current_value
- repos + databases on disk — vs source_code / db paths

**Detects and reports (PROPOSE-ONLY):**
- **undocumented** — live job/cron/db/flag/process not in the registry
- **active-retired** — component marked retired/archived but still running live
- **duplicate-owners** — a capability with more than one primary_owner (violates rule 2)
- **conflicting-schedules** — two jobs scheduled to collide / overlapping owners of one schedule
- **missing-runtime** — registry says active but no live process/job found
- **stale-records** — last_verified_at older than threshold, or source_of_truth moved

**Output:** a diff report + a set of proposed CHANGE-IMPACT-REPORT-shaped records for Jarvis to review. It NEVER auto-applies a production change, deletes a job, or rewrites ownership. Proposals go to Jarvis (and, where the action-gradient requires, to B). This is the mechanism that keeps documented == reality over time and fills the INITIAL registry's `unknown` gaps.

---

## RELEASE CRITERION

A change is NOT complete / NOT live until ALL of the following hold:

1. **Production-call-path-proven** — a real production entry point (daemon/CLI/cron/hook) demonstrably reaches the code (daemon-level or end-to-end test, not only unit). (ADR-0003 / INC-2026-06-18.)
2. **Registry-updated** — components.json / capabilities.json / dependencies.json reflect the change.
3. **Decision-record-updated** — the relevant ADR exists and is current.
4. **Impact-report-passes** — the CHANGE-IMPACT REPORT above is produced and not gate-blocked.
5. **Old-path-status-recorded** — any replaced path has its status (shadow/deprecated/retired/justified-retained) recorded.
6. **Tests + canary pass** — the proving tests and the canary plan both pass.
7. **Rollback-demonstrated** — the rollback steps are concrete and have been demonstrated (not aspirational).
8. **Runtime-reconciliation-confirms documented == reality** — the nightly reconciliation (or an on-demand run) confirms the registry now matches the live system.

Until all eight hold, the change is in-progress. "Built + tested + committed" is explicitly NOT "live."
