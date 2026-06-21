# ADR-0005: Ack-protocol tracked-object rule + Phase 2 system-model finish

- **Status:** accepted
- **Date:** 2026-06-21
- **Deciders:** B (ack-protocol directive), Jarvis (Phase 2 finish-sprint)
- **Related components:** tool.ack-protocol-check, publishing.topstep-notifier, data.headline-log, metric.run-goodput, service.run-store, db.runs, flag.FEATURE_COMPLETION_CONTRACT, flag.FEATURE_OUTCOME_HB, flag.FEATURE_LEASE_JOIN, flag.FEATURE_TRACE_ID
- **Related commits:** 7623880 (completion-contract cutover), 6db4248 (durable run_events), this docs commit

## Problem

Two things needed closing in the Jarvis self-model.

1. **B's ack-protocol rule.** B made an identity-level rule: an acknowledgement is not completion, and a promise to work requires a tracked object (task_id / run_id / commitment_id). Without enforcement, "on it" and "working on it" promises have no durable handle and can silently vanish. There was no rule in the system-model or the comms policy capturing this, and no check.

2. **The self-model had verified-real components missing and a stale flag state.** Four live, on-disk-verified components were not in the registry: the run_goodput outcome metric, the Topstep once-per-day dedup notifier, the Sentinel headline-log H3 data sidecar, and (now) the ack-protocol check itself. Separately, the registry described all six feature flags as OFF/dormant (true at commit 7623880's "all 6 flags FALSE"), but the production feature-flags.json now has FEATURE_TRACE_ID, FEATURE_OUTCOME_HB, FEATURE_COMPLETION_CONTRACT and FEATURE_LEASE_JOIN set true. Documented did not equal reality.

Verified evidence:
- `state/jarvis-core/feature-flags.json` reads `{TRACE_ID:true, OUTCOME_HB:true, DOCTOR_GOODPUT:false, COMPLETION_CONTRACT:true, LEASE_JOIN:true, SANDBOX_CANARY:false}`. `src/utils/feature-flags.ts:3` hardcodes that path as the production source.
- `src/daemon/run-contract.ts:201-212` emits the `run_goodput` heartbeat (only PRODUCTIVE is healthy).
- `~/cortextos-data/tools/topstep-bot/topstep-notifier.py` implements persisted once-per-trading-day dedup; launchd `ai.jarvis.topstep-notifier` StartInterval 60s.
- `~/cortextos-data/sentinel/headline-log.jsonl` is appending (63 lines, latest ts_seen 2026-06-21T21:34Z); README confirms read-only H3 data collection, B-approved 2026-06-21.

## Decision

1. **Ack-protocol rule.** Add to system-model `RULES.md` as permanent rule 11 and to the Jarvis comms policy (`GUARDRAILS.md` WS3 reflex 5): "An acknowledgement is not completion. A promise to work requires a tracked object (task_id / run_id / commitment_id)."
2. **Advisory check.** Ship `tools/ack_protocol_check.py` (+ `test_ack_protocol_check.py`): given an outbound B-message, flag any future-work/commitment phrase with no tracked-object id. Advisory, not a hard block (exit 3 = FLAG, exit 0 = OK, exit 1 = error).
3. **Encode the enforcement rules** in RULES.md (no new component without a capability search; no replacement without an old-path retirement condition; no "live" claim without a production-call-path proof; no unknown component modified without investigation; nightly reconciliation is read-only/propose-only).
4. **Register the four verified components** in `components.json` (+ capabilities, dependencies) with real source paths and honest exit-code contracts; mark unverifiable contracts null.
5. **Correct the flag drift.** Set the four flags' `current_value` to true with a note, and lift `service.run-store` + `db.runs` and the completion-contract capability family from `shadow` to `active`, because the cutover commit gave them a live production call path (the daemon worker exit handler) and the flags are on. SoT for flag state is the flags file, not the stale source-code comment.
6. **Add two registries:** `system-model/source-of-truth.md` (one fact -> one source) and `system-model/exit-codes.md` (exit-code semantics, including reconciler exit 2 = drift-fixed).

New primary owners introduced: `agent.jarvis` owns `ack-protocol-enforcement`; `service.run-store` owns `outcome-goodput`; `data.headline-log` owns `headline-latency-data-collection`; `publishing.topstep-notifier` owns `topstep-notification-dedup`.

## Why

- The ack-protocol rule is a class-level fix for silent-promise drift: a tracked object is the durable handle that makes a promise auditable. An advisory check (not a hard block) matches B's framing ("a check") and avoids gating real comms on a regex.
- Registering only disk-verified components respects zero-fabrication. The four added components were each confirmed on disk (source path, plist, live output) before recording.
- The flag drift correction follows RULES.md rule 3: the source (the flags file) wins over stale prose. Documenting all-false when production is on would be a worse error than recording the drift.

## Alternatives Rejected

- **Make the ack-check a hard pre-send block (exit 1, gate the send)** — rejected: B framed it as a check, and a regex false-positive should never block a real B-message. Advisory exit code 3 keeps it informational.
- **Leave the flags documented as OFF until a full daemon-level re-test** — rejected: the file is the source of truth and is on now; recording OFF would be a known-false claim. The honest record is "on, drift noted," with the production-call-path proof from the cutover commit and the reachability guard.
- **Infer exit-code contracts for the new launchd executables** — rejected where unverified (topstep-notifier LastExitStatus not pulled this pass); left null per RULES.md rule 8.

## Assumptions

- The production flags path in `src/utils/feature-flags.ts` is the one the running daemon reads (verified: hardcoded, override only via CTX_FEATURE_FLAGS_PATH for tests).
- The cutover commit 7623880 wired the completion contract into the daemon worker exit handler (per its message + ADR-0002); not re-executed end-to-end this pass.

## Risks

- Marking run-store active on flag-state + cutover-commit evidence (not a fresh end-to-end daemon test this pass) could overstate liveness if the cutover wiring regressed. Mitigated: the nightly reconciliation and the feature-reachability guard both cross-check; the rollback is a one-line flag flip.
- The ack-check regex could false-positive/negative on unusual phrasings. Mitigated: it is advisory only; 12 unit tests cover the canonical cases.
- Blast radius is documentation + one advisory script; no trading, money, credentials, flags-file, or live-cron were modified.

## Rollback

- Docs (RULES.md, GUARDRAILS.md, SYSTEM-MAP.md, source-of-truth.md, exit-codes.md, the three JSON registries, this ADR): `git checkout` the prior versions. Note: `orgs/` is gitignored in the cortextos repo, so the jarvis-workspace docs and the check script live outside the tracked tree; rollback there is file-restore, not git revert.
- The ack-protocol check + test are additive standalone files with no runtime dependency; delete to remove.
- The flag `current_value` and run-store status edits are registry-only; they describe reality and do not change runtime. No production behavior was altered by this change.

## Evidence That Would Reverse

- The production feature-flags.json being read by the daemon turns out to be a different file than `src/utils/feature-flags.ts` points at (would mean the live flag state is not what was recorded -> re-derive).
- A daemon-level test shows the completion-contract path is NOT actually reached despite the flags being true (would drop run-store back to shadow per the "no live claim without production-call-path proof" rule).
