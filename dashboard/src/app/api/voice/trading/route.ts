import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import fs from 'fs';
import { auth } from '@/lib/auth';
import { excludedRowsSql } from '@/lib/prediction-display-config';

// SQL predicate that is TRUE for display-excluded (test-run) rows. The LIVE
// stats below subtract these so the headline real-money figure isn't dragged by
// the frozen Sidewinder/Kalshi BTC test run. Data is never modified.
const EXCLUDED_SQL = excludedRowsSql();

export const dynamic = 'force-dynamic';

const DB_PATH =
  '/Users/chrisjackson/.openclaw/workspace/discordbot/prediction/state/prediction_trades.db';

interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  lastTrade: { pnl: number; lane: string; direction: string; closedAt: string } | null;
}

interface KalshiAccount {
  cash: number;
  total_value: number;
  deposit: number;
  net_pnl: number;
  updated_at: string;
}

interface StrategyAllocation {
  strategy_id: string;
  display_name: string;
  status: string;
  deposited: number;
  gross_pnl: number;
  fee_drag: number;
  realized_pnl: number; // net, fees in
  current_value: number;
  wins: number;
  losses: number;
  pct_of_account: number | null;
}

interface CapitalLedger {
  strategies: StrategyAllocation[];
  reconciliation: { drift: number | null; account_total_value: number | null };
}

interface TradingData {
  live: TradeStats;
  paper: TradeStats;
  kalshiAccount: KalshiAccount | null;
  allocation: CapitalLedger | null;
  todayLiveNet: number;
  recentTrades: { lane: string; direction: string; pnl: number; closedAt: string }[];
  paperLanes: { lane: string; net: number; wins: number; losses: number }[];
}

const KALSHI_SNAPSHOT =
  '/Users/chrisjackson/.openclaw/workspace/discordbot/prediction/state/kalshi-snapshot.json';
const CAPITAL_LEDGER =
  '/Users/chrisjackson/.openclaw/workspace/discordbot/prediction/state/capital-ledger.json';

// Per-strategy capital allocation (virtual envelopes inside the one Kalshi account):
// each strategy's deposited / net-of-fees P&L / current value, reconciled to the
// real balance. Lets the dashboard show which strategy owns/made what.
function readCapitalLedger(): CapitalLedger | null {
  try {
    const led = JSON.parse(fs.readFileSync(CAPITAL_LEDGER, 'utf-8'));
    if (led.error) return null;
    return led as CapitalLedger;
  } catch {
    return null;
  }
}

// Real Kalshi account balance + net-vs-deposit — the actual money, not just the
// gross trade P&L, so the dashboard always shows what is really in the account.
function readKalshiAccount(): KalshiAccount | null {
  try {
    const snap = JSON.parse(fs.readFileSync(KALSHI_SNAPSHOT, 'utf-8'));
    if (snap.error) return null;
    return snap as KalshiAccount;
  } catch {
    return null;
  }
}

function emptyStats(): TradeStats {
  return { total: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, lastTrade: null };
}

function queryStats(
  db: Database.Database,
  paperMode: number,
  excludeTestRuns = false,
): TradeStats {
  const stats = emptyStats();
  // For the LIVE figure, drop display-excluded test-run rows (data intact).
  const exclClause = excludeTestRuns ? ` AND NOT ${EXCLUDED_SQL}` : '';

  const countRow = db
    .prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses, COALESCE(SUM(pnl), 0) as net_pnl FROM prediction_trades WHERE paper_mode = ? AND closed_at IS NOT NULL AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')${exclClause}`,
    )
    .get(paperMode) as { total: number; wins: number; losses: number; net_pnl: number } | undefined;

  if (countRow) {
    stats.total = countRow.total;
    stats.wins = countRow.wins || 0;
    stats.losses = countRow.losses || 0;
    stats.winRate = countRow.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0;
    stats.netPnl = Math.round(countRow.net_pnl * 100) / 100;
  }

  const lastRow = db
    .prepare(
      `SELECT pnl, lane, direction, closed_at FROM prediction_trades WHERE paper_mode = ? AND closed_at IS NOT NULL AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%')${exclClause} ORDER BY closed_at DESC LIMIT 1`,
    )
    .get(paperMode) as { pnl: number; lane: string; direction: string; closed_at: string } | undefined;

  if (lastRow) {
    stats.lastTrade = {
      pnl: Math.round(lastRow.pnl * 100) / 100,
      lane: lastRow.lane,
      direction: lastRow.direction,
      closedAt: lastRow.closed_at,
    };
  }

  return stats;
}

// Today's LIVE (real-money) net P&L — so the check-in shows if today is green/red.
function queryTodayLiveNet(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pnl),0) as net FROM prediction_trades WHERE paper_mode=0 AND closed_at IS NOT NULL AND date(closed_at)=date('now') AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%') AND NOT ${EXCLUDED_SQL}`,
    )
    .get() as { net: number } | undefined;
  return row ? Math.round(row.net * 100) / 100 : 0;
}

// The last few LIVE fills — the actual recent action, not just totals.
function queryRecentTrades(db: Database.Database, limit = 5) {
  const rows = db
    .prepare(
      `SELECT lane, direction, pnl, closed_at FROM prediction_trades WHERE paper_mode=0 AND closed_at IS NOT NULL AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%') AND NOT ${EXCLUDED_SQL} ORDER BY closed_at DESC LIMIT ?`,
    )
    .all(limit) as { lane: string; direction: string; pnl: number; closed_at: string }[];
  return rows.map((r) => ({ lane: r.lane, direction: r.direction, pnl: Math.round(r.pnl * 100) / 100, closedAt: r.closed_at }));
}

// Paper lanes roll-up (the other strategies we're testing) — whole-picture view.
function queryPaperLanes(db: Database.Database) {
  const rows = db
    .prepare(
      "SELECT lane, COALESCE(SUM(pnl),0) as net, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl<=0 THEN 1 ELSE 0 END) as losses FROM prediction_trades WHERE paper_mode=1 AND closed_at IS NOT NULL AND (notes IS NULL OR notes NOT LIKE '%DUP_QUARANTINE%') GROUP BY lane ORDER BY net DESC",
    )
    .all() as { lane: string; net: number; wins: number; losses: number }[];
  return rows.map((r) => ({ lane: r.lane, net: Math.round(r.net * 100) / 100, wins: r.wins || 0, losses: r.losses || 0 }));
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!fs.existsSync(DB_PATH)) {
    return NextResponse.json({
      live: emptyStats(),
      paper: emptyStats(),
      kalshiAccount: readKalshiAccount(),
      allocation: readCapitalLedger(),
      todayLiveNet: 0,
      recentTrades: [],
      paperLanes: [],
    } satisfies TradingData);
  }

  try {
    const db = new Database(DB_PATH, { readonly: true });
    const result: TradingData = {
      live: queryStats(db, 0, true), // exclude display-excluded test runs from LIVE
      paper: queryStats(db, 1),
      kalshiAccount: readKalshiAccount(),
      allocation: readCapitalLedger(),
      todayLiveNet: queryTodayLiveNet(db),
      recentTrades: queryRecentTrades(db),
      paperLanes: queryPaperLanes(db),
    };
    db.close();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({
      live: emptyStats(),
      paper: emptyStats(),
      kalshiAccount: readKalshiAccount(),
      allocation: readCapitalLedger(),
      todayLiveNet: 0,
      recentTrades: [],
      paperLanes: [],
    } satisfies TradingData);
  }
}
