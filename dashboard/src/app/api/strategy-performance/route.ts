import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getLivePnlExclusion } from '@/lib/prediction-display-config';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE B — strategy-performance data for the predictions chart.
// READ-ONLY consumption of the prediction bot's data files. We NEVER touch the
// bot logic, .env, or KILL_SWITCH.
//
// Three real sources, each mapped explicitly:
//  1. prediction_trades.db  -> live/paper P&L, win rate, EDGE METRIC per strategy
//                              (edge = realized win-rate − breakeven win-rate,
//                               where breakeven = avg entry price; slip/fee
//                               folded in via the recorded pnl which already
//                               includes fees on the live btc lane).
//  2. capital-ledger.json   -> reconciled REAL-broker P&L for the live btc lane
//                              (fee-adjusted realized_pnl, current_value).
//  3. TALLY-2026-06-03.md    -> backtest VERDICTS (killed / 0-survivors) and any
//                              stated WFE/DSR/OOS numbers. These are narrative,
//                              so we surface the text verbatim and extract a few
//                              numbers via regex; where absent -> null (n/a).
//
// The funnel pass bar (threshold line): slip+fee-adjusted net edge > 0
// (and the documented DSR>=0.95 / PBO<0.5 secondary gate). Plotted as edge=0.
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const PRED_ROOT = path.join(HOME, '.openclaw/workspace/discordbot/prediction');
const TRADES_DB = path.join(PRED_ROOT, 'state/prediction_trades.db');
const CAPITAL_JSON = path.join(PRED_ROOT, 'state/capital-ledger.json');
const TALLY_MD = path.join(
  HOME,
  '.openclaw/workspace/discordbot/deliverables/edge-hunt/TALLY-2026-06-03.md',
);

// The 9 named lanes (lane dirs lane1_glint … lane9_clock map to these lane keys).
const LANE_LABELS: Record<string, string> = {
  glint: 'Glint (lane1)',
  btc: 'Sidewinder / BTC (lane2)',
  arb: 'Arb (lane3)',
  crypto: 'Crypto (lane4)',
  eth: 'ETH',
  sol: 'SOL',
  weather: 'Weather (lane5)',
  macro: 'Macro (lane6)',
  ghost: 'Ghost (lane7)',
  nighthawk: 'Nighthawk (lane8)',
  clock: 'Clock (lane9)',
  // strategy-tagged paper variants found in the trades DB:
  btc_4569band_paper: 'BTC 45-69c band (paper)',
  btc_6c20c_paper: 'BTC 6c-20c (paper)',
  btc_panicfade_paper: 'BTC panic-fade (paper)',
};

interface StratRow {
  lane: string;
  paper_mode: number;
  trade_count: number;
  resolved: number;
  open_count: number;
  wins: number;
  losses: number;
  avg_entry: number | null;
  net_pnl: number;
  last_trade_at: string | null;
  first_trade_at: string | null;
}

// Curated per-lane backtest verdicts. The previous version regex-searched the TALLY
// narrative, which OVER-matched: "sol" ∈ "re-sol-ved", a stray "weather" example
// mention in an unrelated REJECTED lead, and a 'btc' hint that bled Sidewinder's killed
// verdict onto EVERY btc* lane (6c-20c, panic-fade falsely killed). We now map ONLY lanes
// with a CONFIRMED verdict; everything else returns null (unproven / paper-collecting).
// Source: edge-hunt TALLY "already killed OOS (do NOT re-claim)" list (2026-06-03).
// Structured per Atlas redesign data-gap #2 (stage + verdict_reason).
interface LaneVerdict {
  verdict: 'killed' | 'survivor' | 'pending';
  reason: string;
  wfe: number | null;
  dsr: number | null;
  oos_winrate: number | null;
  sample_size: number | null;
}
const LANE_VERDICTS: Record<string, LaneVerdict> = {
  // Sidewinder crypto-15min lag (base) — the btc lane's strategy. Killed OOS.
  btc: {
    verdict: 'killed',
    reason: 'Sidewinder crypto-15min lag (base) — REJECTED: 2mo OOS 53.4%, hot-streak, SURVIVES=False',
    wfe: null,
    dsr: null,
    oos_winrate: 53.4,
    sample_size: null,
  },
  // 55-70c / 45-69c NO band. Killed OOS.
  btc_4569band_paper: {
    verdict: 'killed',
    reason: '55-70c NO band — REJECTED: 2mo OOS 63.8%, WFE 0.29, slip-adj -0.049, SURVIVES=False',
    wfe: 0.29,
    dsr: null,
    oos_winrate: 63.8,
    sample_size: null,
  },
  // All other lanes (eth, sol, weather, ghost, glint, nighthawk, btc_6c20c_paper,
  // btc_panicfade_paper) have NO confirmed kill verdict → null (unproven / paper).
};

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

// Return the curated verdict for a lane, or all-nulls when there's no CONFIRMED verdict.
// Lookup is by lane key only (no narrative regex → no over-matching). `_tally`/`_label`
// kept for call-site signature compatibility.
function extractVerdict(_tally: string | null, lane: string, _label: string) {
  const v = LANE_VERDICTS[lane];
  if (!v) {
    return {
      verdict: null as string | null,
      ledger_excerpt: null as string | null,
      wfe: null as number | null,
      dsr: null as number | null,
      oos_winrate: null as number | null,
      sample_size: null as number | null,
    };
  }
  return {
    verdict: v.verdict as string | null,
    ledger_excerpt: v.reason as string | null,
    wfe: v.wfe,
    dsr: v.dsr,
    oos_winrate: v.oos_winrate,
    sample_size: v.sample_size,
  };
}

export async function GET(_request: NextRequest) {
  const missing: string[] = [];

  // ── capital-ledger.json — reconciled real-broker truth for the live lane ──
  let capital: Record<string, unknown> | null = null;
  if (fs.existsSync(CAPITAL_JSON)) {
    try {
      capital = JSON.parse(fs.readFileSync(CAPITAL_JSON, 'utf-8'));
    } catch {
      /* leave null */
    }
  } else {
    missing.push('capital-ledger.json');
  }

  // ── TALLY ledger — backtest verdicts (narrative) ──
  let tally: string | null = null;
  if (fs.existsSync(TALLY_MD)) {
    try {
      tally = fs.readFileSync(TALLY_MD, 'utf-8');
    } catch {
      /* leave null */
    }
  } else {
    missing.push('TALLY-2026-06-03.md');
  }

  // Hunt-ledger headline: tried N / survivors.
  let huntTally: { tried: number | null; survivors: number | null; summary: string | null } = {
    tried: null,
    survivors: null,
    summary: null,
  };
  if (tally) {
    const triedM = tally.match(/~?(\d+)\s+strateg(?:ies|y)\/?(?:leads)?\s+tested/i);
    const survM = tally.match(/(?:TRUE\s+)?survivors?:?\s*(\d+)/i);
    huntTally = {
      tried: triedM ? Number(triedM[1]) : null,
      survivors: survM ? Number(survM[1]) : null,
      summary:
        '0 fundable survivors (per ledger) — in-hand-testable hunt exhausted; remaining leads resource-gated.',
    };
  }

  // ── prediction_trades.db — per-strategy P&L / win rate / edge ──
  if (!fs.existsSync(TRADES_DB)) {
    missing.push('prediction_trades.db');
    return Response.json({
      strategies: [],
      capital,
      hunt_tally: huntTally,
      threshold: { edge: 0, label: 'slip+fee-adjusted net edge > 0 (DSR≥0.95 / PBO<0.5)' },
      data_availability: { missing },
    });
  }

  let db: Database.Database | null = null;
  try {
    db = openRO(TRADES_DB);
    if (!db) {
      missing.push('prediction_trades.db (open failed)');
      return Response.json({
        strategies: [],
        capital,
        hunt_tally: huntTally,
        threshold: { edge: 0, label: 'slip+fee-adjusted net edge > 0 (DSR≥0.95 / PBO<0.5)' },
        data_availability: { missing },
      });
    }

    const rows = db
      .prepare(
        `
      SELECT
        lane,
        paper_mode,
        COUNT(*) AS trade_count,
        SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losses,
        AVG(entry_price) AS avg_entry,
        COALESCE(SUM(pnl), 0) AS net_pnl,
        MAX(created_at) AS last_trade_at,
        MIN(created_at) AS first_trade_at
      FROM prediction_trades
      WHERE (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')
      GROUP BY lane, paper_mode
      ORDER BY trade_count DESC
    `,
      )
      .all() as StratRow[];

    const strategies = rows.map((r) => {
      const isLive = r.paper_mode === 0;
      const resolved = r.wins + r.losses; // resolved with a directional outcome
      // Win rate over resolved-with-outcome trades.
      const winRate = resolved > 0 ? r.wins / resolved : null;
      // Breakeven win-rate = average entry price paid (a binary contract bought at
      // price p needs to win > p of the time to be profitable BEFORE fees).
      const breakeven = r.avg_entry != null ? r.avg_entry : null;
      // EDGE METRIC: realized win-rate − breakeven. >0 = (pre-fee) edge.
      // For the LIVE btc lane, recorded pnl already nets fees, so net_pnl/trade is
      // the truer fee-adjusted signal; we expose both.
      const edge = winRate != null && breakeven != null ? winRate - breakeven : null;
      const pnlPerTrade = r.trade_count > 0 ? r.net_pnl / r.trade_count : null;

      const label = LANE_LABELS[r.lane] ?? r.lane;
      const v = extractVerdict(tally, r.lane, label);

      // DISPLAY exclusion: is this (lane, paper_mode) a test run excluded from
      // the headline live-P&L? Data stays, we just flag + label it.
      const excl = getLivePnlExclusion(r.lane, r.paper_mode);

      // Tag: live / paper-live / backtest-only / killed.
      // An excluded LIVE test run gets its own tag so the chart/table can dim it.
      let tag: 'paper-live' | 'live' | 'killed' | 'backtest-only' | 'test-excluded';
      if (excl) tag = 'test-excluded';
      else if (v.verdict === 'killed') tag = 'killed';
      else if (isLive) tag = 'live';
      else tag = 'paper-live';

      return {
        lane: r.lane,
        paper_mode: r.paper_mode,
        label,
        is_live: isLive,
        tag,
        excluded: !!excl,
        excluded_label: excl?.label ?? null,
        excluded_reason: excl?.reason ?? null,
        trade_count: r.trade_count,
        resolved,
        open_count: r.open_count,
        wins: r.wins,
        losses: r.losses,
        win_rate: winRate, // 0..1 or null
        breakeven, // avg entry price 0..1 or null
        edge, // win_rate − breakeven, or null
        net_pnl: Math.round(r.net_pnl * 100) / 100,
        pnl_per_trade: pnlPerTrade != null ? Math.round(pnlPerTrade * 1000) / 1000 : null,
        last_trade_at: r.last_trade_at,
        first_trade_at: r.first_trade_at,
        backtest: {
          verdict: v.verdict, // 'killed' | 'survivor' | 'pending' | null
          wfe: v.wfe,
          dsr: v.dsr,
          oos_winrate: v.oos_winrate,
          sample_size: v.sample_size,
          ledger_excerpt: v.ledger_excerpt,
        },
      };
    });

    return Response.json({
      strategies,
      capital, // reconciled real-broker truth for the live lane
      hunt_tally: huntTally,
      threshold: {
        edge: 0,
        label: 'Funnel pass bar: slip+fee-adjusted net edge > 0 (secondary: DSR≥0.95 / PBO<0.5)',
      },
      data_availability: { missing },
    });
  } catch (err) {
    console.error('[api/strategy-performance] GET error:', err);
    return Response.json({ error: 'Failed to read strategy performance' }, { status: 500 });
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}
