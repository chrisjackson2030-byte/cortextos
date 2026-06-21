# SYSTEM-MAP

GENERATED from system-model/*.json — never manually authoritative. Regenerate after any registry change; the nightly reconciliation keeps it == reality. Refreshed 2026-06-21 from components.json (Phase 2 finish-sprint).

Total components: 42. Status=unknown (needs investigation): 3 — db.claims, launchd.fleet-jobs-registry-note, plus topstep-notifier exit-contract-unverified (status active, exit codes null). 2026-06-21: four flags (TRACE_ID, OUTCOME_HB, COMPLETION_CONTRACT, LEASE_JOIN) are now TRUE in production feature-flags.json (were OFF at commit 7623880); run-store + db.runs lifted shadow->active. See system-model/source-of-truth.md drift note.

## Agents

- **Atlas** (`agent.atlas`) — status: deprecated · owner: jarvis · SoT: orgs/main/agents/atlas/config.json (enabled=false)
- **Forge** (`agent.forge`) — status: active · owner: jarvis · SoT: orgs/main/agents/forge/config.json
- **Friday** (`agent.friday`) — status: active · owner: jarvis · SoT: orgs/main/agents/friday/config.json
- **Hermes** (`agent.hermes`) — status: active · owner: jarvis · SoT: orgs/main/agents/hermes/config.json
- **Jarvis** (`agent.jarvis`) — status: active · owner: B · SoT: config.json (model/runtime/crons)
- **Nova** (`agent.nova`) — status: active · owner: jarvis · SoT: orgs/main/agents/nova/config.json

## Services

- **cortextos daemon** (`service.daemon`) — status: active · owner: cortextos-core · SoT: src/daemon/* + per-agent config.json
- **daemon cron-scheduler** (`service.cron-scheduler`) — status: active · owner: cortextos-core · SoT: config.json crons array (24 crons)
- **feature-reachability guard** (`guard.feature-reachability`) — status: active · owner: cortextos-core · SoT: self (scan result)
- **run-store (completion contract)** (`service.run-store`) — status: active (lifted from shadow 2026-06-21; flags live) · owner: cortextos-core · SoT: db.runs (runs.db) + run_events table
- **Telegram fast-checker** (`service.fast-checker`) — status: active · owner: cortextos-core · SoT: Telegram API
- **run_goodput outcome metric** (`metric.run-goodput`) — status: active · owner: service.run-store · SoT: db.runs (drives classifyOutcome); gated on FEATURE_OUTCOME_HB (true)
- **ack-protocol check (comms linter)** (`tool.ack-protocol-check`) — status: active · owner: agent.jarvis · SoT: self (regex); RULES.md rule 11 is policy SoT

## Sidecars

- **codex-fallback** (`service.codex-fallback`) — status: active · owner: jarvis · SoT: per-agent config.json runtime field + override stamp

## Watchdogs / Notifiers

- **ai.cortextos.security-monitor / security-watchdog** (`watchdog.security-monitor`) — status: active · owner: cortextos-core · SoT: unknown
- **ai.jarvis.loop-watchdog** (`watchdog.loop-watchdog`) — status: active · owner: jarvis · SoT: unknown
- **ai.jarvis.reconciler** (`watchdog.reconciler`) — status: active (exit 2 = drift-fixed = healthy, ADR-0004) · owner: jarvis · SoT: ~/cortextos/orgs/main/desired-state.json (read-only)
- **Topstep notifier (once-per-day dedup)** (`publishing.topstep-notifier`) — status: active (exit-contract unverified) · owner: jarvis · SoT: notifier cursor JSON (dedup) + REAL Topstep account (facts)

## Databases / Data

- **claims.db** (`db.claims`) — status: unknown · owner: cortextos-core (hooks) · SoT: self
- **halt-state.db** (`db.halt_state`) — status: active · owner: discordbot (Alpaca options bot) · SoT: self (halt state)
- **runs.db** (`db.runs`) — status: active (lifted from shadow 2026-06-21) · owner: cortextos-core · SoT: self (canonical run lifecycle + run_events)
- **sessions.db** (`db.sessions`) — status: active · owner: cortextos-core · SoT: self (session index)
- **source_log.db** (`db.source_log`) — status: active · owner: cortextos-core (hooks) · SoT: self
- **headline-log.jsonl** (`data.headline-log`) — status: active · owner: jarvis · SoT: self (append-only H3 latency data; ts_seen anchor)

## Feature Flags (current_value as of 2026-06-21, SoT = state/jarvis-core/feature-flags.json)

- **FEATURE_COMPLETION_CONTRACT** (`flag.FEATURE_COMPLETION_CONTRACT`) — value: TRUE · status: active · owner: cortextos-core
- **FEATURE_TRACE_ID** (`flag.FEATURE_TRACE_ID`) — value: TRUE · status: active · owner: cortextos-core
- **FEATURE_OUTCOME_HB** (`flag.FEATURE_OUTCOME_HB`) — value: TRUE · status: active · owner: cortextos-core
- **FEATURE_LEASE_JOIN** (`flag.FEATURE_LEASE_JOIN`) — value: TRUE · status: active · owner: cortextos-core
- **FEATURE_DOCTOR_GOODPUT** (`flag.FEATURE_DOCTOR_GOODPUT`) — value: FALSE · status: proposed · owner: cortextos-core
- **FEATURE_SANDBOX_CANARY** (`flag.FEATURE_SANDBOX_CANARY`) — value: FALSE · status: shadow · owner: cortextos-core

## External Integrations

- **better-sqlite3** (`lib.better-sqlite3`) — status: active (12.11.1 on this branch; 11.x on main is retirement target) · owner: cortextos-core · SoT: package.json dependency pin
- **ChatGPT Plus Codex OAuth** (`integration.codex-oauth`) — status: active · owner: jarvis · SoT: ChatGPT account
- **Claude Max OAuth** (`integration.claude-max-oauth`) — status: active · owner: B · SoT: Anthropic account
- **macOS Keychain (get_secret)** (`credential.keychain`) — status: active · owner: B · SoT: self (Keychain)
- **Telegram** (`integration.telegram`) — status: active · owner: cortextos-core · SoT: Telegram API

## launchd Jobs

- **com.cortextos.daemon** (`launchd.daemon`) — status: active · owner: cortextos-core · SoT: plist
- **launchd fleet jobs (full set)** (`launchd.fleet-jobs-registry-note`) — status: unknown · owner: mixed (jarvis / cortextos-core / discordbot) · SoT: each job's plist + script

## Revenue / Trading Lanes

- **Alpaca options bot (Discord)** (`trading.alpaca-options`) — status: deprecated · owner: discordbot · SoT: REAL Alpaca live broker (/v2/account, /v2/positions) — never positions.db
- **Fiverr — edge-audit service** (`revenue.fiverr-edge-audit`) — status: proposed · owner: jarvis · SoT: Fiverr account
- **Kalshi / Sidewinder** (`trading.kalshi-sidewinder`) — status: deprecated · owner: jarvis (lane), Sentinel (interactive advisor, never executes) · SoT: REAL Kalshi account/settlements (never the bot's own DB)
- **Shopify — Quiet Kiln** (`revenue.shopify-quiet-kiln`) — status: active · owner: jarvis · SoT: Shopify Admin (store eudvn4-c0)
- **Topstep (prop firm)** (`trading.topstep`) — status: shadow · owner: jarvis (lane), Sentinel (advisor) · SoT: REAL Topstep account (not bot DB)

## Source-of-truth + exit-code registries

- **system-model/source-of-truth.md** — one fact -> one authoritative source (P&L -> broker, flags -> feature-flags.json, etc.)
- **system-model/exit-codes.md** — per-executable exit-code contracts (reconciler exit 2 = drift-fixed; ack-protocol-check exit 3 = FLAG advisory).
