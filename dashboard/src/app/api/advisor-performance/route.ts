import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// Advisor dashboard data (B 2026-06-04). READ-ONLY consumption of the financial-
// advisor bot's DB. The bot is an ADVISOR not an auto-trader — this surfaces its
// pick track-record so B can decide whether to trust it with real capital.
// Honest by construction: alerts/outcomes start EMPTY (0 picks sent) and fill as
// the advisor fires. NEVER fabricate P&L.
// Sources (advisor.db): alerts (picks sent) + signal_outcomes (scored returns) +
// signals (raw signals) + watchlist (50 tickers).
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const ADVISOR_DB = path.join(HOME, '.openclaw/workspace/financial-advisor/state/advisor.db');

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

interface AlertRow {
  id: number;
  symbol: string;
  conviction: number;
  direction: string;
  entry_price: number | null;
  target_price: number | null;
  stop_loss: number | null;
  position_size_usd: number | null;
  sent_at: string;
  result: string | null;
  return_30d: number | null;
}

export async function GET(_req: NextRequest) {
  if (!fs.existsSync(ADVISOR_DB)) {
    return Response.json({ available: false, reason: 'advisor.db not found' });
  }
  let db: Database.Database | null = null;
  try {
    db = openRO(ADVISOR_DB);
    if (!db) return Response.json({ available: false, reason: 'advisor.db open failed' });

    // ── Picks: alerts + their scored outcome (LEFT JOIN; outcome may be pending/absent) ──
    const picks = db
      .prepare(
        `SELECT a.id, a.symbol, a.conviction, a.direction, a.entry_price, a.target_price,
                a.stop_loss, a.position_size_usd, a.sent_at, o.result, o.return_30d
         FROM alerts a
         LEFT JOIN signal_outcomes o ON o.alert_id = a.id
         ORDER BY a.sent_at ASC`,
      )
      .all() as AlertRow[];

    const hypo = (r: AlertRow) =>
      r.return_30d != null && r.position_size_usd != null
        ? Math.round(r.return_30d * r.position_size_usd * 100) / 100
        : null;

    const resolved = picks.filter((p) => p.result === 'win' || p.result === 'loss');
    const wins = resolved.filter((p) => p.result === 'win').length;
    const hypoPnl = resolved.reduce((s, p) => s + (hypo(p) ?? 0), 0);

    // ── Cumulative hypothetical P&L over time (resolved only) ──
    let run = 0;
    const pnl_series = resolved
      .filter((p) => hypo(p) != null)
      .map((p) => {
        run += hypo(p) ?? 0;
        return { t: Date.parse(p.sent_at), cum: Math.round(run * 100) / 100, symbol: p.symbol };
      });

    // ── Calibration: hit-rate by conviction bucket (resolved) ──
    const buckets = [
      [0.3, 0.45],
      [0.45, 0.6],
      [0.6, 0.75],
      [0.75, 1.01],
    ];
    const calibration = buckets.map(([lo, hi]) => {
      const inB = resolved.filter((p) => p.conviction >= lo && p.conviction < hi);
      const w = inB.filter((p) => p.result === 'win').length;
      return {
        bucket: `${lo.toFixed(2)}-${hi >= 1 ? '1.00' : hi.toFixed(2)}`,
        n: inB.length,
        hit_rate: inB.length ? Math.round((w / inB.length) * 100) / 100 : null,
      };
    });

    // ── Signal-source scorecard: count by signal_type (hit-rate fills once outcomes exist) ──
    const srcRows = db
      .prepare(`SELECT signal_type, COUNT(*) AS n FROM signals GROUP BY signal_type ORDER BY n DESC`)
      .all() as { signal_type: string; n: number }[];

    const watchlist_count = (
      db.prepare(`SELECT COUNT(*) AS n FROM watchlist`).get() as { n: number }
    ).n;
    const signals_total = (
      db.prepare(`SELECT COUNT(*) AS n FROM signals`).get() as { n: number }
    ).n;

    const proven = false; // advisor is not "proven" until the paper track-record clears a bar
    return Response.json({
      available: true,
      summary: {
        status: 'PAPER-TRACKING',
        proven,
        picks_sent: picks.length,
        resolved: resolved.length,
        wins,
        hit_rate: resolved.length ? Math.round((wins / resolved.length) * 100) / 100 : null,
        hypothetical_pnl: Math.round(hypoPnl * 100) / 100,
        watchlist_count,
        signals_total,
        note:
          picks.length === 0
            ? 'No picks sent yet — advisor is live + scheduled; fills as conviction clears the bar.'
            : null,
      },
      picks: picks.map((p) => ({ ...p, hypothetical_pnl: hypo(p) })),
      pnl_series,
      calibration,
      source_scorecard: srcRows,
    });
  } catch (err) {
    console.error('[api/advisor-performance] GET error:', err);
    return Response.json({ error: 'Failed to read advisor performance' }, { status: 500 });
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
