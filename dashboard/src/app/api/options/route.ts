import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const BOT_ROOT = path.join(HOME, '.openclaw/workspace/discordbot');

const KILL_SWITCH_PATH = path.join(BOT_ROOT, 'KILL_SWITCH');
const ACCOUNT_SNAPSHOT = path.join(BOT_ROOT, 'state/account-snapshot.json');
const INTENT_DB = path.join(BOT_ROOT, 'state/intent-ledger.db');
const BROKER_DB = path.join(BOT_ROOT, 'state/broker-health.db');
const HALT_DB = path.join(BOT_ROOT, 'state/halt-state.db');
const DRIFT_DB = path.join(BOT_ROOT, 'state/drift-events.db');

// Caps are env-driven in the bot's config/settings.py. We expose the configured
// values when present in the dashboard env, otherwise the bot defaults. These are
// the CONFIGURED guardrails, not a live broker reading.
const CAPS = {
  max_contracts_per_trade: Number(process.env.DISCORDBOT_MAX_CONTRACTS_PER_TRADE ?? 1),
  max_open_positions: Number(process.env.DISCORDBOT_MAX_OPEN_POSITIONS ?? 3),
  per_trade_max_loss: Number(process.env.DISCORDBOT_PER_TRADE_MAX_LOSS ?? 150),
  daily_max_loss: Number(process.env.DISCORDBOT_DAILY_MAX_LOSS ?? 150),
  market_close_time: process.env.DISCORDBOT_MARKET_CLOSE_TIME ?? '15:55',
  zero_dte_cutoff_time: process.env.DISCORDBOT_ZERO_DTE_CUTOFF_TIME ?? '15:00',
  source: process.env.DISCORDBOT_MAX_CONTRACTS_PER_TRADE ? 'env' : 'default',
};

interface IntentRow {
  intent_id: string;
  client_order_id: string;
  channel_id: string;
  message_id: string;
  signal_json: string;
  state: string;
  broker_order_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  symbol: string;
  qty: number;
  intent_id: string;
  confirmation_state: string;
  entered_at: string;
}

interface HaltRow {
  halt_id: string;
  source_module: string;
  reason_code: string;
  reason_text: string;
  triggered_at: string;
}

function openRO(p: string): Database.Database | null {
  if (!fs.existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true, timeout: 5000 });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(_request: NextRequest) {
  const dbs: Database.Database[] = [];
  const missing: string[] = [];

  try {
    // ---- Kill switch (file present = ARMED / halted) ----
    const killSwitchArmed = fs.existsSync(KILL_SWITCH_PATH);

    // ---- Account snapshot (live Alpaca equity/options buying power) ----
    // Written by scripts/write_account_snapshot.py so the dashboard always shows
    // the real account state — no one has to ask "is it funded?" ever again.
    let account: {
      status: string;
      equity: number;
      cash: number;
      buying_power: number;
      options_buying_power: number;
      options_level: number | null;
      updated_at: string;
    } | null = null;
    if (fs.existsSync(ACCOUNT_SNAPSHOT)) {
      try {
        const snap = JSON.parse(fs.readFileSync(ACCOUNT_SNAPSHOT, 'utf-8'));
        if (!snap.error) account = snap;
      } catch {
        /* ignore — tile falls back to "no account data" */
      }
    } else {
      missing.push('account-snapshot.json');
    }

    // ---- Broker health ----
    let broker: {
      state: string;
      consecutive_failures: number;
      last_probe_at: string | null;
      override_state: string | null;
    } | null = null;
    const brokerDb = openRO(BROKER_DB);
    if (brokerDb) {
      dbs.push(brokerDb);
      const row = brokerDb
        .prepare(
          'SELECT state, consecutive_failures, last_probe_at, override_state FROM broker_health_state WHERE id = 1',
        )
        .get() as
        | {
            state: string;
            consecutive_failures: number;
            last_probe_at: string | null;
            override_state: string | null;
          }
        | undefined;
      broker = row ?? null;
    } else {
      missing.push('broker-health.db');
    }

    // ---- Active halts ----
    let activeHalts: HaltRow[] = [];
    const haltDb = openRO(HALT_DB);
    if (haltDb) {
      dbs.push(haltDb);
      activeHalts = haltDb
        .prepare(
          `SELECT halt_id, source_module, reason_code, reason_text, triggered_at
           FROM halts WHERE cleared_at IS NULL OR cleared_at = ''
           ORDER BY triggered_at DESC`,
        )
        .all() as HaltRow[];
    } else {
      missing.push('halt-state.db');
    }

    // ---- Local positions (drift detector SSOT for held qty) ----
    let positions: PositionRow[] = [];
    const driftDb = openRO(DRIFT_DB);
    if (driftDb) {
      dbs.push(driftDb);
      positions = driftDb
        .prepare(
          `SELECT symbol, qty, intent_id, confirmation_state, entered_at
           FROM local_positions ORDER BY entered_at DESC`,
        )
        .all() as PositionRow[];
    } else {
      missing.push('drift-events.db');
    }

    // ---- Order intents (signals + fills) ----
    let intents: IntentRow[] = [];
    const intentDb = openRO(INTENT_DB);
    if (intentDb) {
      dbs.push(intentDb);
      intents = intentDb
        .prepare(
          `SELECT intent_id, client_order_id, channel_id, message_id, signal_json,
                  state, broker_order_id, failure_reason, created_at, updated_at
           FROM order_intents ORDER BY created_at DESC LIMIT 50`,
        )
        .all() as IntentRow[];
    } else {
      missing.push('intent-ledger.db');
    }

    // Decorate intents with parsed signal fields
    const signals = intents.map((i) => {
      const sig = safeParse(i.signal_json);
      return {
        intent_id: i.intent_id,
        state: i.state,
        ticker: (sig.ticker as string) ?? null,
        action: (sig.action as string) ?? null,
        right: (sig.right as string) ?? null,
        strike: (sig.strike as string) ?? null,
        expiry: (sig.expiry as string) ?? null,
        price: (sig.price as string) ?? null,
        contracts: (sig.contracts as number) ?? null,
        raw_text: (sig.raw_text as string) ?? null,
        broker_order_id: i.broker_order_id,
        failure_reason: i.failure_reason,
        created_at: i.created_at,
        updated_at: i.updated_at,
      };
    });

    // Intent state breakdown
    const stateCounts: Record<string, number> = {};
    for (const i of intents) {
      stateCounts[i.state] = (stateCounts[i.state] ?? 0) + 1;
    }

    const filledCount = (stateCounts.FILLED ?? 0) + (stateCounts.RESOLVED_FILLED ?? 0);
    const failedCount = stateCounts.FAILED ?? 0;

    // Derive a single overall status for the bot
    let status: 'HALTED' | 'DEGRADED' | 'LIVE' | 'UNKNOWN';
    if (killSwitchArmed || activeHalts.length > 0) status = 'HALTED';
    else if (broker?.state === 'DEGRADED' || broker?.state === 'DOWN') status = 'DEGRADED';
    else if (broker?.state === 'HEALTHY') status = 'LIVE';
    else status = 'UNKNOWN';

    return Response.json({
      status,
      kill_switch: {
        armed: killSwitchArmed,
        path: KILL_SWITCH_PATH,
      },
      account,
      broker,
      active_halts: activeHalts,
      positions,
      signals,
      intent_states: stateCounts,
      summary: {
        total_signals: intents.length,
        open_positions: positions.length,
        filled: filledCount,
        failed: failedCount,
      },
      caps: CAPS,
      data_availability: {
        missing,
        // P&L for the options bot is NOT tracked in these state DBs — it lives in
        // Alpaca and the reconcile script. We do not fabricate a number here.
        pnl_available: false,
      },
    });
  } catch (err) {
    console.error('[api/options] GET error:', err);
    return Response.json({ error: 'Failed to read options bot state' }, { status: 500 });
  } finally {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}
