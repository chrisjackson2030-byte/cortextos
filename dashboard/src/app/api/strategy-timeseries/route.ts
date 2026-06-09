import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getLivePnlExclusion } from '@/lib/prediction-display-config';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// Paper-results-over-time (Atlas redesign §5). READ-ONLY: cumulative P&L per
// (lane, paper_mode) over time, so B can watch each strategy's results adjust.
// We NEVER touch bot logic / .env / KILL_SWITCH. Cumulative pnl is computed from
// closed trades ordered by closed_at — data already in prediction_trades.db.
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const PRED_ROOT = path.join(HOME, '.openclaw/workspace/discordbot/prediction');
const TRADES_DB = path.join(PRED_ROOT, 'state/prediction_trades.db');

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
  btc_4569band_paper: 'BTC 45-69c band (paper)',
  btc_6c20c_paper: 'BTC 6c-20c (paper)',
  btc_panicfade_paper: 'BTC panic-fade (paper)',
};

interface TradeRow {
  lane: string;
  paper_mode: number;
  pnl: number | null;
  closed_at: string;
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

export async function GET(_request: NextRequest) {
  if (!fs.existsSync(TRADES_DB)) {
    return Response.json({ series: [], data_availability: { missing: ['prediction_trades.db'] } });
  }

  let db: Database.Database | null = null;
  try {
    db = openRO(TRADES_DB);
    if (!db) {
      return Response.json({
        series: [],
        data_availability: { missing: ['prediction_trades.db (open failed)'] },
      });
    }

    const rows = db
      .prepare(
        `
      SELECT lane, paper_mode, pnl, closed_at
      FROM prediction_trades
      WHERE closed_at IS NOT NULL
        AND pnl IS NOT NULL
        AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')
      ORDER BY closed_at ASC
    `,
      )
      .all() as TradeRow[];

    // Build cumulative series per (lane, paper_mode).
    const seriesMap = new Map<
      string,
      { lane: string; paper_mode: number; points: { t: number; cum: number }[]; running: number }
    >();

    for (const r of rows) {
      const key = `${r.lane}__${r.paper_mode}`;
      const t = Date.parse(r.closed_at);
      if (Number.isNaN(t)) continue;
      let s = seriesMap.get(key);
      if (!s) {
        s = { lane: r.lane, paper_mode: r.paper_mode, points: [], running: 0 };
        seriesMap.set(key, s);
      }
      s.running += r.pnl ?? 0;
      s.points.push({ t, cum: Math.round(s.running * 100) / 100 });
    }

    const series = [...seriesMap.values()]
      .filter((s) => s.points.length >= 2) // a line needs ≥2 points
      .map((s) => {
        const isLive = s.paper_mode === 0;
        const excl = getLivePnlExclusion(s.lane, s.paper_mode);
        let tag: 'paper-live' | 'live' | 'test-excluded';
        if (excl) tag = 'test-excluded';
        else if (isLive) tag = 'live';
        else tag = 'paper-live';
        return {
          key: `${s.lane}__${s.paper_mode}`,
          lane: s.lane,
          label: LANE_LABELS[s.lane] ?? s.lane,
          paper_mode: s.paper_mode,
          is_live: isLive,
          tag,
          excluded: !!excl,
          net: s.points[s.points.length - 1]?.cum ?? 0,
          trade_count: s.points.length,
          points: s.points,
        };
      })
      .sort((a, b) => b.trade_count - a.trade_count);

    return Response.json({ series, data_availability: { missing: [] } });
  } catch (err) {
    console.error('[api/strategy-timeseries] GET error:', err);
    return Response.json({ error: 'Failed to read strategy timeseries' }, { status: 500 });
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
