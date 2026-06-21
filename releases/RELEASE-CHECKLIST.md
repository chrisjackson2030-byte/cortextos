# Release Checklist

Every release that promotes a self-improvement to the live system MUST pass this
checklist. The checklist is a gate, not advice. A release that skips any required
gate is not promoted. This composes with `system-model/RULES.md` (the 10 rules +
RELEASE CRITERION) and ADR-0003 (a feature is not live until a production call
path is proven).

There is NO autonomous promotion. Promotion is a human/reviewer action recorded
in a release RECORD (`releases/records/<release_id>.json`). The proposer
(`tools/release_proposer.py`) only ever produces a PROPOSAL.

---

## Gate list (every release)

1. **Change-impact report present.** A CHANGE-IMPACT REPORT (the JSON format in
   `system-model/RULES.md`) exists for this change and is not gate-blocked.
   Reference it in the record's `change_impact_report_ref`. REQUIRED for any release.

2. **Eval / test gate passes.** The proving tests run and pass (production call
   path proven per ADR-0003, not unit-only for behavior changes). Capture output
   to a proof note and reference it in `tests.test_output_ref`.

3. **Independent reviewer for behavior changes.** Any `weekly-behavior-release`
   or `human-approval` change requires a reviewer DIFFERENT from the author, with
   a recorded verdict. `nightly-safe-update` (docs / inventories / reconciliation
   proposals, no behavior change) may use a lighter reviewer but still records one.

4. **Canary before promotion.** Behavior changes are canaried (shadow / single
   instance / limited blast radius) with an observed PASS result BEFORE full
   promotion. No canary, no promotion for behavior changes.

5. **Rollback command present and demonstrated.** The record carries an exact
   rollback command (flag flip, revert, file restore) and `rollback_demonstrated`
   is true. Aspirational rollbacks do not count (RULES.md RELEASE CRITERION #7).

6. **Release notes written.** A human-readable `release_notes` describing what
   shipped and the operator impact.

7. **Runtime reconciliation confirms documented == reality** after promotion
   (RULES.md RELEASE CRITERION #8).

---

## Category gates (what each category additionally requires)

| Category | Reviewer | Canary | Human approval | Can ever auto-promote? |
|---|---|---|---|---|
| `nightly-safe-update` (docs, inventories, reconciliation proposals) | light | not required | not required | NO. Reviewer promotes via record. |
| `weekly-behavior-release` (behavior change) | independent, required | required | not required (unless protected path) | NO. Reviewer + canary, then human/reviewer promotes. |
| `human-approval` (money / risk / trading / credentials / permissions / live-crons / live-prompts) | independent, required | required | REQUIRED, explicit | NO. Blocked until a human approves. |

Even the lightest category never auto-promotes. "Promotion" is always a recorded
human/reviewer action.

---

## BLOCKED categories (cannot promote without explicit human approval)

The following are `human-approval` category, and the live-config guard
(`tools/live_config_guard.py`) BLOCKS any direct agent write to them outside an
approved release record:

- feature-flags (`**/feature-flags.json`)
- live crons (`**/agents/*/config.json` crons array)
- credentials (`.env`, `secrets*.json`, `*.key`, `*.pem`)
- money / risk / trading settings
- live prompts (IDENTITY.md, SOUL.md, GUARDRAILS.md, system prompts)
- permissions (`settings.json`, `.claude/settings*.json`)

A self-update that touches any of these is auto-escalated to `human-approval` by
the proposer and cannot be down-classified by the caller.

---

## Sign-off

A release is promoted only when every required box for its category is checked
in the release RECORD, and (for `human-approval`) `human_approved` is true with a
named approver and timestamp.
