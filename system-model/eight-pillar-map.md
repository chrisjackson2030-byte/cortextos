# Jarvis Eight-Pillar Map

Generated: 2026-06-18 by jarvis. INITIAL pass. Maps the system across the 8 pillars of an autonomous agent. "unknown" is used honestly where coverage is unverified; the nightly reconciliation fills gaps over time. Component ids reference `system-model/components.json`.

---

## 1. Perception (how the system senses the world)

- **current_components:** service.fast-checker (Telegram inbound), integration.telegram, db.sessions (indexer), transcript-embeddings.db (memory recall), the data-ingest launchd class (ai.jarvis.*-ingest, ai.crypto.*, ai.prediction.*, market/futures/equity/COT/SEC feeds), WebSearch/internet-pulse crons.
- **primary_owner:** cortextos-core (comms/indexer); jarvis (intelligence ingest lanes).
- **source_of_truth:** Telegram API (B input); each data feed's upstream API; sessions.db (session index).
- **missing_capability:** No single registry of which ingest feeds are fresh vs stale at a glance (per feedback_stale_data_trust). Per-feed freshness/timestamp surfacing is partial.
- **duplicated_or_overlapping_systems:** Multiple source_log.db instances across state subdirs; several overlapping market-data refresh jobs (crypto-refresh, crypto-ohlcv-refresh, futures-ingest, futures-yahoo-refresh) whose boundaries are unverified.
- **production_call_paths:** fast-checker -> daemon -> jarvis worker (verified); ingest launchd -> scripts -> DBs (per-job unverified).
- **tests:** unknown for ingest feeds; fast-checker tested unknown.
- **health_signals:** fast-checker.log; ai.jarvis.ingestion-engine running; per-feed freshness checks (partial).
- **security_boundary:** ALLOWED_USER gate on Telegram; ingest feeds are read-only external pulls.
- **rollback:** disable a feed's launchd job; revert WS7 fast-path (d4930e3).
- **next_planned_improvement:** mechanized per-feed freshness ledger so "is it working" = data-fresh, not process-alive (feedback_alive_not_working).

---

## 2. Reasoning + planning (how the system decides)

- **current_components:** agent.jarvis (orchestrator reasoning), agent.nova (analyst studies), edge-research capability (hunt-director, prospector-cycle, judgment-engine), funnel_v2 forward-validation, rehearse.py (think-like-B), acting-b subagent.
- **primary_owner:** agent.jarvis.
- **source_of_truth:** funnel_v2 OOS verdicts + killed-edges registry (state/session-context.md); GOALS.md / goals.json for goal state.
- **missing_capability:** No persisted, queryable decision log linking decisions to ADRs beyond this new architecture/decisions/ set (just introduced).
- **duplicated_or_overlapping_systems:** Several edge-research loops (hunt-director, prospector-cycle, judgment-engine, internet-pulse) with overlapping intake; ownership consolidated under jarvis but boundaries fuzzy.
- **production_call_paths:** jarvis worker decisions (verified); crons hunt-director/prospector dispatch (config.json, verified present).
- **tests:** funnel_v2 forward-validation; rehearse scoring; no unit tests for orchestrator judgment (not unit-testable).
- **health_signals:** killed-edge registry growth; goal cascade freshness.
- **security_boundary:** money/irreversible/external actions gated to B (action-gradient).
- **rollback:** decisions are reversible via ADR rollback sections; no live-money decision arms on a stored label.
- **next_planned_improvement:** every non-trivial decision -> an ADR + a CHANGE-IMPACT REPORT (this workstream).

---

## 3. Action + tools (how the system acts)

- **current_components:** cortextos bus CLI (send-telegram, send-message, tasks, crons), spawn-worker / Agent subagents, 31 CLI skills (~/.claude/skills/cli-*), Shopify Admin API (revenue.shopify-quiet-kiln), trading lanes (gated).
- **primary_owner:** agent.jarvis (orchestration actions); cortextos-core (bus CLI).
- **source_of_truth:** bus CLI = src/bus/*; task store; agent inboxes.
- **missing_capability:** No machine-checked pre-action change-impact gate yet (this workstream introduces the format; enforcement is the next step).
- **duplicated_or_overlapping_systems:** CLI vs MCP overlap (policy: CLI > MCP by default); multiple scheduling surfaces (config.json crons vs launchd).
- **production_call_paths:** jarvis -> bus CLI -> side effects (verified); shopify-operator cron -> Shopify Admin (verified present).
- **tests:** bus modules have unit tests (tests/unit/bus/*); action-level integration partial.
- **health_signals:** task completion events; cron fire ledger.
- **security_boundary:** action-gradient (auto / report-after / ask-first / never); Keychain-only secrets; Max-OAuth firewall.
- **rollback:** per-action (Shopify edits revertible; messages not revertible — hence ask-first on external comms).
- **next_planned_improvement:** enforce the CHANGE-IMPACT REPORT before any change that creates a new service/cron/agent/db/permission/credential/external-action.

---

## 4. Memory + canonical state (what the system remembers / treats as truth)

- **current_components:** memory/YYYY-MM-DD.md (daily), ~/.claude/.../memory topic files (durable), state/session-context.md (boot index projection, regenerated each boot), MEMORY.md (auto-generated index), db.sessions, transcript-embeddings.db, dream/memory-refresh consolidation.
- **primary_owner:** agent.jarvis (own memory); cortextos-core (indexer/boot generator).
- **source_of_truth:** daily memory + topic files are canonical; state/session-context.md is a generated projection (never hand-authoritative); MEMORY.md is auto-generated (hand-edits overwritten). For money: the REAL broker, never a bot DB.
- **missing_capability:** This system-model registry is the first canonical self-model store (previously memory was prose, not a queryable registry).
- **duplicated_or_overlapping_systems:** Boot index vs MEMORY.md vs shared/Strategist index — documented as distinct; risk of confusing them (CLAUDE.md calls this out).
- **production_call_paths:** generate-session-context.py at boot (verified in CLAUDE.md protocol); dream Stop-hook (verified, has singleton-guard gotcha).
- **tests:** unknown for memory generators.
- **health_signals:** memory-freshness-alarm (com.cortextos.memory-freshness-alarm launchd); >=3 memory entries/session target.
- **security_boundary:** agents consolidate only their OWN memory (shared/ is the exception); SOUL.md/USER.md never modified without B approval.
- **rollback:** memory files are git-tracked / append-only daily; regenerate boot index from disk.
- **next_planned_improvement:** the registry (components/capabilities/dependencies.json) becomes the canonical self-model; nightly reconciliation keeps it == reality.

---

## 5. Feedback + evaluation (how the system knows if it worked)

- **current_components:** outcome-heartbeat capability (FEATURE_OUTCOME_HB, shadow), completion-contract (shadow), eval-runner (com.cortextos.eval-runner, ai.jarvis.eval-daily), Nova nightly-metrics + daily-audit, paper-integrity, acceptance-report, confidence-calibration-log.
- **primary_owner:** service.run-store (run-level outcome); agent.nova (system metrics).
- **source_of_truth:** db.runs (run outcomes, once contract live); eval-runner results; REAL broker for trading outcomes.
- **missing_capability:** Outcome contract is SHADOW (flags OFF) — production runs still judged by bare exit code. This is the live gap ADR-0002/0003 address.
- **duplicated_or_overlapping_systems:** heartbeat (process-alive) vs outcome-heartbeat (goodput) — intentionally layered, not yet both live.
- **production_call_paths:** legacy bare-exit (live); outcome heartbeat wired but flag OFF (shadow, not yet a live call path — the INC-2026-06-18 lesson).
- **tests:** tests/unit/bus/outcome-hb.test.ts; eval-runner; Nova metrics.
- **health_signals:** outcome heartbeat UNHEALTHY signal (when on); eval pass rates; Theta score (Nova).
- **security_boundary:** evaluation is read-only over outcomes.
- **rollback:** flags OFF -> legacy evaluation.
- **next_planned_improvement:** prove the outcome-heartbeat production call path, then flip FEATURE_OUTCOME_HB on in a shadow/parity window.

---

## 6. Durable control plane (what keeps the system running reliably)

- **current_components:** service.daemon, launchd.daemon (KeepAlive), service.cron-scheduler, watchdog.loop-watchdog / loop-liveness / cron-reconciler, run-lease (FEATURE_LEASE_JOIN, shadow), codex-fallback, ai.jarvis.system-doctor, circuit-breaker, disk-pressure, log-rotate.
- **primary_owner:** cortextos-core (daemon); jarvis (watchdog/fallback lanes).
- **source_of_truth:** config.json (crons, max_session_seconds); per-agent config.json (runtime); plist files (launchd).
- **missing_capability:** No reconciliation that the documented control plane (this registry) == the live one — that is the NIGHTLY READ-ONLY RECONCILIATION this workstream specifies but does not yet automate.
- **duplicated_or_overlapping_systems:** Two scheduling planes (daemon cron-scheduler vs ~110 launchd jobs); two liveness watchdogs (loop-watchdog + loop-liveness); config crons != daemon crons (known gotcha).
- **production_call_paths:** launchd -> daemon -> workers (verified); cron-scheduler -> crons (verified).
- **tests:** tests/unit/daemon/cron-scheduler.test.ts; lease-join tests; disposable-daemon tests (per ADR-0002).
- **health_signals:** launchctl list; loop-fire-ledger; system-doctor; ai.jarvis.reconciler (currently exit 2 — needs investigation).
- **security_boundary:** daemon spawns workers; security-monitor/watchdog overlay.
- **rollback:** launchctl unload; flags OFF; self-restart / hard-restart.
- **next_planned_improvement:** automate the nightly reconciliation (registry vs launchd vs daemon-crons vs running-processes vs flags) as PROPOSE-ONLY.

---

## 7. System self-model (does the system understand itself)

- **current_components:** THIS workstream — system-model/components.json, capabilities.json, dependencies.json, SYSTEM-MAP.md, this eight-pillar-map, RULES.md, architecture/decisions/*.
- **primary_owner:** agent.jarvis.
- **source_of_truth:** system-model/*.json (canonical registry); SYSTEM-MAP.md is a generated projection (never hand-authoritative).
- **missing_capability:** Coverage is INITIAL — ~110 launchd jobs recorded as a class (unknown), claims.db path unconfirmed, reconciler scope unknown, several agents' permissions/data-flows marked unknown. The self-model does not yet cover the full fleet.
- **duplicated_or_overlapping_systems:** None yet (this is the first canonical self-model); risk is drift between registry and reality without the nightly reconciliation.
- **production_call_paths:** registry is read by Jarvis at change-time (the change-impact gate) — enforcement not yet automated.
- **tests:** JSON parse-validation (each .json json.load-checked); no semantic tests yet.
- **health_signals:** nightly reconciliation diff count (once automated); count of status=unknown records (currently several — see SYSTEM-MAP).
- **security_boundary:** registry is documentation; no credentials stored in it (references Keychain by name only).
- **rollback:** registry is git-tracked; revert files.
- **next_planned_improvement:** nightly reconciliation fills unknowns and flags undocumented/active-retired/duplicate-owner/conflicting-schedule/missing-runtime/stale records as PROPOSE-ONLY.

---

## 8. Security / governance / releases (how the system stays safe and accountable)

- **current_components:** watchdog.security-monitor + security-watchdog, FEATURE_SANDBOX_CANARY (Gate H credential containment), credential.keychain (get_secret), guard.feature-reachability, action-gradient, RULES.md change-impact gate + release criterion, Max-OAuth firewall, security-self-upkeep cron, security-vet skill.
- **primary_owner:** cortextos-core (security monitors); B (governance / action-gradient authority); jarvis (release gate execution).
- **source_of_truth:** RULES.md (the 10 rules + release criterion); GUARDRAILS.md; action-gradient.md; Keychain (secrets).
- **missing_capability:** The change-impact gate and release criterion are now documented but not yet mechanically enforced on every change; reconciliation not automated.
- **duplicated_or_overlapping_systems:** security-monitor vs security-watchdog (two jobs, boundary unverified); feature-reachability guard vs release criterion (complementary).
- **production_call_paths:** feature-reachability guard runs at release (verified present, c99ed3f); security monitors via launchd (verified present, scope unknown).
- **tests:** Gate H red-team canary (commit 6dac6d3); security micro-gate symlink-escape fix (8ba8079); copy_lint pre-send gate.
- **health_signals:** security-monitor/watchdog launchd; confidence-calibration-log (fabrication incidents); copy_lint exit codes.
- **security_boundary:** Keychain-only secrets; Max-OAuth Cortext-only firewall; sandbox deny Keychain+securityd for canary agents; never-list in action-gradient (no access revoke, no SOUL.md edit, etc).
- **rollback:** flags OFF; launchctl unload; config backups (Gate H reversible); git revert.
- **next_planned_improvement:** enforce the release criterion (production-call-path-proven + registry/ADR/impact-report updated + tests/canary + rollback demonstrated + reconciliation == reality) as a hard gate on every change.
