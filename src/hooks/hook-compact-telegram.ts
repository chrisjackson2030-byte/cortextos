/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction,
 * so the user knows why the agent goes quiet for a moment (#18).
 *
 * Also arms the discordbot KILL_SWITCH and inserts a halt record so the
 * compaction watchdog (compaction_watchdog.py, launchd every 30s) can
 * auto-clear the halt when Jarvis resumes and touches jarvis-alive.txt.
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Safety: ALL new code is wrapped in try/catch. Telegram fetch is raced
 * against a 5s abort signal. KILL_SWITCH + halt insert run synchronously
 * first (fast — file touch + one DB write) so they land before the process
 * exits, then Telegram fires as fire-and-forget.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { loadEnv } from './index.js';

// Discordbot paths (belt-and-suspenders: env var override, then hardcoded default)
const KILL_SWITCH_PATH =
  process.env.DISCORDBOT_KILL_SWITCH_PATH ||
  '/Users/chrisjackson/.openclaw/workspace/discordbot/KILL_SWITCH';

const HALT_STATE_DB =
  process.env.DISCORDBOT_HALT_STATE_DB ||
  '/Users/chrisjackson/.openclaw/workspace/discordbot/state/halt-state.db';

// Minimal schema required by compaction_watchdog.py — matches halt_state.py exactly.
// Uses IF NOT EXISTS so it's safe to run against an already-initialized DB.
const HALT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS halts (
    halt_id         TEXT PRIMARY KEY,
    source_module   TEXT NOT NULL,
    reason_code     TEXT NOT NULL,
    reason_text     TEXT NOT NULL,
    context_json    TEXT,
    triggered_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    cleared_at      TEXT,
    cleared_by      TEXT,
    cleared_reason  TEXT,
    CHECK (source_module IN ('intent_ledger','broker_health','drift_detector','operator','risk_engine'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_halts_unique_active
    ON halts(source_module, reason_code) WHERE cleared_at IS NULL;
`;

/**
 * Arm the KILL_SWITCH file and insert a jarvis_compacting halt record.
 *
 * Two-mechanism approach (belt-and-suspenders):
 *   a. Touch KILL_SWITCH file directly — immediate, no DB dependency.
 *   b. Insert halt record via better-sqlite3 — enables watchdog auto-clear on resume.
 *
 * Both are individually try/caught. Either succeeding is useful; neither failing
 * must ever block compaction.
 */
async function armHaltForCompaction(): Promise<void> {
  // ── Mechanism A: arm KILL_SWITCH file with the compaction sentinel ───────
  // Exclusive create ('wx'): write the sentinel ONLY when creating the file from
  // absence. If it already exists (operator/B armed it, or a prior compaction),
  // the write throws EEXIST and we leave the existing file untouched. The sentinel
  // lets compaction_watchdog.py auto-remove ONLY a compaction-armed file on resume
  // — never an operator-armed one. This string MUST match
  // COMPACTION_KILL_SWITCH_SENTINEL in src/discordbot/services/halt_state.py.
  try {
    mkdirSync(dirname(KILL_SWITCH_PATH), { recursive: true });
    writeFileSync(KILL_SWITCH_PATH, 'armed-by:jarvis_compacting\n', { flag: 'wx' });
  } catch {
    // EEXIST (already armed) or any error — non-fatal; existing file is preserved.
  }

  // ── Mechanism B: insert halt record (enables watchdog auto-clear) ────────
  try {
    // Dynamic import so a missing/broken native binding never crashes the hook
    const { default: Database } = await import('better-sqlite3');

    const db = new Database(HALT_STATE_DB);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');

    // Ensure halt table exists (safe against already-initialized DB)
    db.exec(HALT_SCHEMA_SQL);

    // halt_id format matches Python's enter_halt() for audit consistency
    const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const haltId = `halt-operator-${ts}-${randomBytes(4).toString('hex')}`;

    db.prepare(`
      INSERT OR IGNORE INTO halts
        (halt_id, source_module, reason_code, reason_text, triggered_at)
      VALUES
        (?, 'operator', 'jarvis_compacting',
         'Claude Code context compaction in progress',
         strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(haltId);

    db.close();
  } catch {
    // Non-fatal — KILL_SWITCH file was already touched above
  }
}

async function main(): Promise<void> {
  // Arm halt first (synchronous-in-async, fast) so it lands before logging
  await armHaltForCompaction();

  // 2026-06-10 B noise directive (+ standing rule feedback_compaction_notifications:
  // "compaction/restart -> disk only, never Telegram"). Compactions were paging B
  // 6+ times/night. Log to disk instead; the KILL_SWITCH arming above is unchanged.
  try {
    const env = loadEnv();
    const agentName = env.agentName || 'agent';
    const { appendFileSync } = await import('fs');
    const logPath = '/Users/chrisjackson/.openclaw/workspace/discordbot/logs/compaction-events.log';
    appendFileSync(
      logPath,
      `${new Date().toISOString()} [${agentName}] context compaction started (telegram suppressed — disk-only per feedback_compaction_notifications)\n`,
    );
  } catch {
    // Never fail — compaction must not be blocked
  }
}

main().catch(() => process.exit(0));
