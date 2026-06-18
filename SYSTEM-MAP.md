# SYSTEM-MAP

GENERATED from system-model/*.json — never manually authoritative. Regenerate after any registry change; the nightly reconciliation keeps it == reality. Generated 2026-06-18 from components.json.

Total components: 38. Status=unknown (needs investigation): 3 — watchdog.reconciler, db.claims, launchd.fleet-jobs-registry-note.

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
- **run-store (completion contract)** (`service.run-store`) — status: shadow · owner: cortextos-core · SoT: db.runs (runs.db)
- **Telegram fast-checker** (`service.fast-checker`) — status: active · owner: cortextos-core · SoT: Telegram API

## Sidecars

- **codex-fallback** (`service.codex-fallback`) — status: active · owner: jarvis · SoT: per-agent config.json runtime field + override stamp

## Watchdogs

- **ai.cortextos.security-monitor / security-watchdog** (`watchdog.security-monitor`) — status: active · owner: cortextos-core · SoT: unknown
- **ai.jarvis.loop-watchdog** (`watchdog.loop-watchdog`) — status: active · owner: jarvis · SoT: unknown
- **ai.jarvis.reconciler** (`watchdog.reconciler`) — status: unknown · owner: jarvis · SoT: unknown

## Databases

- **claims.db** (`db.claims`) — status: unknown · owner: cortextos-core (hooks) · SoT: self
- **halt-state.db** (`db.halt_state`) — status: active · owner: discordbot (Alpaca options bot) · SoT: self (halt state)
- **runs.db** (`db.runs`) — status: shadow · owner: cortextos-core · SoT: self (canonical run lifecycle state)
- **sessions.db** (`db.sessions`) — status: active · owner: cortextos-core · SoT: self (session index)
- **source_log.db** (`db.source_log`) — status: active · owner: cortextos-core (hooks) · SoT: self

## Feature Flags

- **FEATURE_COMPLETION_CONTRACT** (`flag.FEATURE_COMPLETION_CONTRACT`) — status: shadow · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json
- **FEATURE_DOCTOR_GOODPUT** (`flag.FEATURE_DOCTOR_GOODPUT`) — status: proposed · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json
- **FEATURE_LEASE_JOIN** (`flag.FEATURE_LEASE_JOIN`) — status: shadow · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json
- **FEATURE_OUTCOME_HB** (`flag.FEATURE_OUTCOME_HB`) — status: shadow · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json
- **FEATURE_SANDBOX_CANARY** (`flag.FEATURE_SANDBOX_CANARY`) — status: shadow · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json
- **FEATURE_TRACE_ID** (`flag.FEATURE_TRACE_ID`) — status: shadow · owner: cortextos-core · SoT: state/jarvis-core/feature-flags.json

## External Integrations

- **better-sqlite3** (`lib.better-sqlite3`) — status: shadow · owner: cortextos-core · SoT: package.json dependency pin
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

