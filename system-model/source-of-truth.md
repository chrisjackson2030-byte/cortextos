# Source-of-Truth Registry

One fact, one authoritative source. (RULES.md rule 3: every fact has exactly one named `source_of_truth`; read the source, never a cache, snapshot, or prose summary.)

Generated 2026-06-21 from `system-model/*.json` plus on-disk verification. When a fact and its claimed source disagree, the SOURCE wins and the registry record is corrected, not the other way around.

| Fact / question | Authoritative source (READ THIS) | Never trust instead |
|---|---|---|
| Trading P&L (any lane) | the REAL broker API for that lane | the bot's own DB / ledger / positions.db |
| Alpaca options P&L + equity | Alpaca live broker: `/v2/account`, `/v2/positions` | `positions.db` (under-records), `intent-ledger.db` |
| Kalshi / Sidewinder P&L | REAL Kalshi account + settlements | the bot's own settlements DB / paper ledger |
| Topstep P&L + account state | REAL Topstep account | topstep shadow ledger / analytics DB |
| Feature-flag state (live) | `orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json` (the production path hardcoded in `src/utils/feature-flags.ts`) | source-code comments (the "all-false" comment is STALE; the file governs), registry `current_value` if it lags the file |
| Run lifecycle state (run_id / status / lease) | `runs.db` `runs` table | JSONL summaries, prose, transcript text |
| Run terminal + parent-join events | `runs.db` `run_events` table (authoritative, idempotent on event_key PK) | structural inference of "it must have joined" |
| Agent runtime / model / crons | that agent's `config.json` (`runtime`, `model`, `crons` + override stamp) | memory headlines, MEMORY.md prose |
| Daemon crons actually scheduled | jarvis `config.json` `crons` array (24) reconciled by `src/daemon/cron-scheduler.ts` | a `/loop` you think you set; crons expire after 7 days and are re-derived from config |
| launchd jobs actually loaded | `launchctl list` + each job's `~/Library/LaunchAgents/*.plist` | the registry's `launchd.fleet-jobs-registry-note` (a CLASS note pending enumeration) |
| Whether a process is running | `ps` / `launchctl list <label>` (live) | registry `runtime_process` field (a snapshot) |
| Exit-code health of an executable | the component's exit-code contract in `components.json` + `system-model/exit-codes.md`, applied by `src/utils/exit-code-classifier.ts` | "nonzero = failure" default (that was INC-2026-06-18) |
| Secrets / API keys | macOS Keychain via `get_secret <name>` | `.env` plaintext, logs, chat |
| Session / transcript index | `sessions.db` (indexer writer) | re-reading raw transcripts ad hoc |
| Session boot context | `state/session-context.md` (regenerated each boot by `generate-session-context.py`) | stale `MEMORY.md` (it is a projection of session-context, refreshed each boot) |
| Killed edges / strategy verdicts | full `funnel_v2` OOS verdict (real mechanism + true cross-arena trial count) surfaced into `state/session-context.md` | a stored strategy label; money never arms on a stored label |
| Shopify store state (Quiet Kiln) | Shopify Admin (store `eudvn4-c0`) | local asset copies, content drafts |
| Telegram inbound/outbound | Telegram API (via fast-checker poll / `send-telegram`) | local message cache |
| Quiet Kiln post-already-sent | `assets/persona-store/quietkiln/videos/post-*/.source` consumption sidecars (poster `qk-daily-post.sh`) | guessing which clip was last posted |
| Topstep alert already-sent today | the notifier cursor JSON (once-per-trading-day dedup state; `topstep-notifier.py`) | re-deriving from the raw event log |
| Headline-to-equity H3 latency data | `~/cortextos-data/sentinel/headline-log.jsonl` (append-only, `ts_seen` anchor) | re-scraping feeds after the fact (point-in-time is lost) |
| better-sqlite3 version in effect | `package.json` dependency pin on the checked-out branch | memory of "we upgraded it" |
| What this system looks like | `system-model/components.json` + `dependencies.json` reconciled by the nightly read-only reconciliation | any single agent's recollection |

## Drift note (recorded honestly, 2026-06-21)

- The production `feature-flags.json` now has `FEATURE_TRACE_ID`, `FEATURE_OUTCOME_HB`, `FEATURE_COMPLETION_CONTRACT`, and `FEATURE_LEASE_JOIN` set **true**. `FEATURE_DOCTOR_GOODPUT` and `FEATURE_SANDBOX_CANARY` remain **false**. The registry and SYSTEM-MAP previously described all flags as OFF/dormant (matching commit 7623880's "all 6 flags FALSE"). The flags were flipped after that commit. The SOURCE of truth is the file; the registry records have been updated to match. The source-code comment in `src/utils/feature-flags.ts` ("all-false there") is STALE prose, not the source of truth.
