# ADR-0006: Safe self-update release system (proposal-only, no autonomous promotion)

- **Status:** accepted
- **Date:** 2026-06-21
- **Deciders:** B (directive: Jarvis Core Finish Sprint Phase 3), Jarvis
- **Related components:** tools/release_proposer.py, tools/live_config_guard.py, releases/ scaffolding, system-model/RULES.md (CHANGE-IMPACT + RELEASE CRITERION), ADR-0003 (production-call-path rule)
- **Related commits:** <this framework commit>

## Problem

Jarvis is meant to self-improve over time, but it must NOT freely self-edit production. Without a gate, an agent (or a nightly self-update cron) could flip a feature flag, edit a live cron, rewrite a system prompt, or change a money/risk/trading setting autonomously. That is an unbounded blast radius with no review, no canary, and no human in the loop on the dangerous classes. RULES.md already specified a PROPOSE-ONLY reconciliation and a CHANGE-IMPACT gate, but there was no executable tooling that enforced "propose, do not apply," and nothing mechanically blocked a direct write to protected live config.

## Decision

Introduce a minimal release framework where every self-improvement is PROPOSED and promoted only through a reviewed release record. Concretely:

1. `tools/release_proposer.py` writes a PROPOSAL record and stops. It has no apply/promote/live path and asserts `status=PROPOSED`, `auto_promote=false`, `human_approved=false` before writing. It classifies each change and auto-escalates any change touching a protected path to the `human-approval` category; a caller cannot down-classify a dangerous change.
2. `tools/live_config_guard.py` classifies a target path and BLOCKS (exit 3) any direct agent write to protected live config (feature-flags, live crons, credentials, money/risk/trading settings, live prompts, permissions) unless an explicit, human-approved release record authorizes it.
3. `releases/` carries the record template, the RELEASE-CHECKLIST gate list, the PROPOSAL-WORKFLOW spec, and records. Promotion is always a recorded human/reviewer action; there is no code path that autonomously promotes a proposal to live.
4. Every release requires a change-impact report (the RULES.md format).

Source-of-truth for "what is protected" is the guard's `PROTECTED_PATTERNS` table; the proposer imports the guard so the classification is single-sourced.

## Why

- It is the direct, class-level fix for the risk "agent self-edits production": the only paths that change production protected config now go through a human-approved record, and the guard blocks the rest mechanically rather than relying on judgment under load.
- Proposal-only with auto-escalation means the safe-by-default behavior cannot be bypassed by mis-categorizing a change.
- It composes with ADR-0003 (a feature is not live until a production call path is proven) and RULES.md (CHANGE-IMPACT + RELEASE CRITERION): the release record carries exactly the evidence those rules demand.
- Built tonight as framework only: it enforces the gates without promoting anything, satisfying "build the gates, promote nothing autonomously."

## Alternatives Rejected

- **Trust the agent to self-restrain (policy doc only)** rejected: a prose rule does not stop a write under load. The incident class this defends against is precisely "the rule existed but was skipped." Needs mechanical enforcement (the guard) plus a tool with no apply path (the proposer).
- **Allow auto-promotion for low-risk categories** rejected: even nightly-safe-update never auto-promotes here. A category boundary is a judgment call that erodes; keeping promotion a recorded human/reviewer action keeps the boundary honest and the audit trail complete.
- **One monolithic release script that both proposes and applies behind a flag** rejected: a flag that gates "apply" is exactly the thing an agent could flip. Separating proposal (this tool) from promotion (a human/reviewer recording a record) removes the autonomous path structurally.

## Assumptions

- The protected-path glob table covers the real protected config locations (feature-flags.json, agent config.json crons, .env/secrets/keys, risk/trading settings, IDENTITY/SOUL/GUARDRAILS prompts, settings.json permissions). False positives fail safe (block, force release flow); the table is extended as new protected paths appear.
- Write paths that should be guarded actually call the guard (pre-commit hook / agent wrapper). The guard is the mechanism; wiring it into every write path is follow-on work tracked separately. Tonight it is proven by tests and CLI, and is the authorization gate for any release-flow write.

## Risks

- A protected write that bypasses the guard entirely (a raw editor write not routed through it) is not caught until the guard is wired into the write path / pre-commit hook. Mitigation: follow-on wiring; the framework and its enforcement logic are in place and tested now.
- Over-broad globs (e.g. all config.json) could block legitimate non-cron writes. Accepted: blocking is the safe direction; the operator promotes via the release flow.

## Rollback

```
git revert <commit-of-this-framework>
```

Removes releases/, tools/release_proposer.py, tools/live_config_guard.py, tools/tests/, ADR-0006, and the change-impact report. The framework is additive and inert until invoked, so reverting restores the prior state with no side effects. No flags, crons, credentials, or money/risk settings were ever touched, so there is nothing live to undo.

## Evidence That Would Reverse

- The guard producing false-blocks at a rate that prevents legitimate releases and cannot be fixed by tightening the glob table.
- A demonstrated case where the proposal-only constraint materially harmed delivery without preventing any real incident (none expected; the standing counter-evidence is the unbounded-self-edit risk this closes).
