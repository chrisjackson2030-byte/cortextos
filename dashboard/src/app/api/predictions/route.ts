import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { excludedRowsSql } from '@/lib/prediction-display-config';

export const dynamic = 'force-dynamic';

const DB_PATH = path.join(
  process.env.HOME ?? '/Users/chrisjackson',
  '.openclaw/workspace/discordbot/prediction/state/prediction_trades.db',
);

// All 9 lanes in the prediction system
const ALL_LANES = [
  'btc',
  'eth',
  'glint',
  'sol',
  'weather',
  'macro',
  'ghost',
  'nighthawk',
  'clock',
] as const;

interface TradeRow {
  id: number;
  lane: string;
  platform: string;
  event_name: string | null;
  contract_id: string | null;
  direction: string | null;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  pnl: number | null;
  signal_source: string | null;
  paper_mode: number;
  created_at: string | null;
  closed_at: string | null;
  notes: string | null;
}

interface LaneSummary {
  lane: string;
  trade_count: number;
  open_count: number;
  wins: number;
  losses: number;
  neutral: number;
  total_pnl: number;
  has_live: boolean;
  has_paper: boolean;
  live_trade_count: number;
  paper_trade_count: number;
  live_pnl: number;
  paper_pnl: number;
  live_wins: number;
  live_losses: number;
  // Exclusion-aware live figures (test-run lanes removed). When a lane has no
  // excluded test run these equal the raw live_* values.
  live_pnl_displayed: number;
  live_wins_displayed: number;
  live_losses_displayed: number;
  live_excluded: boolean; // true if this lane has a display-excluded live test run
  last_trade_at: string | null;
  platform: string | null;
}

interface LaneSummaryRow {
  lane: string;
  trade_count: number;
  open_count: number;
  wins: number;
  losses: number;
  neutral: number;
  total_pnl: number;
  has_live: number;
  has_paper: number;
  live_trade_count: number;
  paper_trade_count: number;
  live_pnl: number;
  paper_pnl: number;
  live_wins: number;
  live_losses: number;
  live_pnl_displayed: number;
  live_wins_displayed: number;
  live_losses_displayed: number;
  live_excluded: number;
  last_trade_at: string | null;
  platform: string | null;
}

export async function GET(_request: NextRequest) {
  if (!fs.existsSync(DB_PATH)) {
    return Response.json(
      {
        error: 'Prediction trades database not found',
        lanes: ALL_LANES.map((lane) => ({
          lane,
          trade_count: 0,
          open_count: 0,
          wins: 0,
          losses: 0,
          neutral: 0,
          total_pnl: 0,
          has_live: false,
          has_paper: false,
          live_trade_count: 0,
          paper_trade_count: 0,
          live_pnl: 0,
          paper_pnl: 0,
          live_wins: 0,
          live_losses: 0,
          live_pnl_displayed: 0,
          live_wins_displayed: 0,
          live_losses_displayed: 0,
          live_excluded: false,
          last_trade_at: null,
          platform: null,
        })),
        totals: {
          trade_count: 0,
          wins: 0,
          losses: 0,
          total_pnl: 0,
          live_pnl: 0,
          paper_pnl: 0,
          live_pnl_displayed: 0,
          live_wins_displayed: 0,
          live_losses_displayed: 0,
          live_lanes_displayed: 0,
          live_pnl_excluded: 0,
          live_wins: 0,
          live_losses: 0,
          live_lanes: 0,
        },
        recent_trades: [],
      },
      { status: 200 },
    );
  }

  // SQL predicate that is TRUE for display-excluded (test-run) rows. Built from
  // the static config in prediction-display-config.ts — no SQL injection surface.
  const EXCLUDED_SQL = excludedRowsSql();

  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, timeout: 5000 });
    db.pragma('busy_timeout = 5000');

    // Per-lane summaries
    const laneSummaries = db
      .prepare(
        `
      SELECT
        lane,
        COUNT(*) as trade_count,
        SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN pnl = 0 OR pnl IS NULL THEN 1 ELSE 0 END) as neutral,
        COALESCE(SUM(pnl), 0) as total_pnl,
        MIN(paper_mode) as has_live,
        MAX(paper_mode) as has_paper,
        SUM(CASE WHEN paper_mode = 0 THEN 1 ELSE 0 END) as live_trade_count,
        SUM(CASE WHEN paper_mode = 1 THEN 1 ELSE 0 END) as paper_trade_count,
        COALESCE(SUM(CASE WHEN paper_mode = 0 THEN pnl ELSE 0 END), 0) as live_pnl,
        COALESCE(SUM(CASE WHEN paper_mode = 1 THEN pnl ELSE 0 END), 0) as paper_pnl,
        SUM(CASE WHEN paper_mode = 0 AND pnl > 0 THEN 1 ELSE 0 END) as live_wins,
        SUM(CASE WHEN paper_mode = 0 AND pnl < 0 THEN 1 ELSE 0 END) as live_losses,
        -- DISPLAY-aware live figures: exclude flagged test-run rows (data intact).
        COALESCE(SUM(CASE WHEN paper_mode = 0 AND NOT ${EXCLUDED_SQL} THEN pnl ELSE 0 END), 0) as live_pnl_displayed,
        SUM(CASE WHEN paper_mode = 0 AND pnl > 0 AND NOT ${EXCLUDED_SQL} THEN 1 ELSE 0 END) as live_wins_displayed,
        SUM(CASE WHEN paper_mode = 0 AND pnl < 0 AND NOT ${EXCLUDED_SQL} THEN 1 ELSE 0 END) as live_losses_displayed,
        MAX(CASE WHEN paper_mode = 0 AND ${EXCLUDED_SQL} THEN 1 ELSE 0 END) as live_excluded,
        MAX(created_at) as last_trade_at,
        platform
      FROM prediction_trades
      WHERE (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')
      GROUP BY lane
      ORDER BY trade_count DESC
    `,
      )
      .all() as LaneSummaryRow[];

    // Build a full map including lanes with no data
    const laneMap = new Map<string, LaneSummary>();
    for (const lane of ALL_LANES) {
      laneMap.set(lane, {
        lane,
        trade_count: 0,
        open_count: 0,
        wins: 0,
        losses: 0,
        neutral: 0,
        total_pnl: 0,
        has_live: false,
        has_paper: false,
        live_trade_count: 0,
        paper_trade_count: 0,
        live_pnl: 0,
        paper_pnl: 0,
        live_wins: 0,
        live_losses: 0,
        live_pnl_displayed: 0,
        live_wins_displayed: 0,
        live_losses_displayed: 0,
        live_excluded: false,
        last_trade_at: null,
        platform: null,
      });
    }

    for (const row of laneSummaries) {
      laneMap.set(row.lane, {
        lane: row.lane,
        trade_count: row.trade_count,
        open_count: row.open_count,
        wins: row.wins,
        losses: row.losses,
        neutral: row.neutral,
        total_pnl: row.total_pnl,
        has_live: row.has_live === 0,
        has_paper: row.has_paper === 1,
        live_trade_count: row.live_trade_count,
        paper_trade_count: row.paper_trade_count,
        live_pnl: row.live_pnl,
        paper_pnl: row.paper_pnl,
        live_wins: row.live_wins,
        live_losses: row.live_losses,
        live_pnl_displayed: row.live_pnl_displayed,
        live_wins_displayed: row.live_wins_displayed,
        live_losses_displayed: row.live_losses_displayed,
        live_excluded: row.live_excluded === 1,
        last_trade_at: row.last_trade_at,
        platform: row.platform,
      });
    }

    const lanes = Array.from(laneMap.values());

    // Totals
    const totals = {
      trade_count: lanes.reduce((s, l) => s + l.trade_count, 0),
      wins: lanes.reduce((s, l) => s + l.wins, 0),
      losses: lanes.reduce((s, l) => s + l.losses, 0),
      total_pnl: lanes.reduce((s, l) => s + l.total_pnl, 0),
      live_pnl: lanes.reduce((s, l) => s + l.live_pnl, 0),
      paper_pnl: lanes.reduce((s, l) => s + l.paper_pnl, 0),
      live_wins: lanes.reduce((s, l) => s + l.live_wins, 0),
      live_losses: lanes.reduce((s, l) => s + l.live_losses, 0),
      live_lanes: lanes.filter((l) => l.has_live).length,
      // DISPLAY-aware live totals (test runs excluded; data intact).
      live_pnl_displayed: lanes.reduce((s, l) => s + l.live_pnl_displayed, 0),
      live_wins_displayed: lanes.reduce((s, l) => s + l.live_wins_displayed, 0),
      live_losses_displayed: lanes.reduce((s, l) => s + l.live_losses_displayed, 0),
      // # of live lanes still counted after exclusion (test-only lanes dropped).
      live_lanes_displayed: lanes.filter(
        (l) => l.has_live && !l.live_excluded,
      ).length,
      // The amount removed from display (for the labelled note). Negative test = positive removal.
      live_pnl_excluded: lanes.reduce(
        (s, l) => s + (l.live_pnl - l.live_pnl_displayed),
        0,
      ),
    };

    // Recent trades (last 20)
    const recentTrades = db
      .prepare(
        `
      SELECT id, lane, platform, event_name, direction, entry_price,
             exit_price, quantity, pnl, signal_source, paper_mode,
             created_at, closed_at, notes
      FROM prediction_trades
      WHERE (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')
      ORDER BY created_at DESC
      LIMIT 20
    `,
      )
      .all() as TradeRow[];

    return Response.json({
      lanes,
      totals,
      recent_trades: recentTrades.map((t) => ({
        ...t,
        paper_mode: t.paper_mode === 1,
      })),
    });
  } catch (err) {
    console.error('[api/predictions] GET error:', err);
    return Response.json(
      { error: 'Failed to read prediction trades' },
      { status: 500 },
    );
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}
