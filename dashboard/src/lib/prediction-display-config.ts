// ─────────────────────────────────────────────────────────────────────────────
// Prediction-market DISPLAY config — P&L exclusion flags.
//
// THIS IS A DISPLAY-ONLY MECHANISM. It does NOT delete data, touch the trading
// bot, .env, KILL_SWITCH, or any money path. It only tells the dashboard which
// (lane, paper_mode) groups to EXCLUDE from the *displayed* live-money P&L total
// and how to label them. The underlying rows in prediction_trades.db are left
// 100% intact and still queryable / still shown in the per-strategy breakdown
// (just flagged "test run — excluded from live total").
//
// WHY: the only real-money run to date is the Sidewinder / Kalshi BTC lane
// (lane='btc', paper_mode=0) — a deliberate ~-$21 TEST run (band edge KILLED OOS,
// all real-money trading FROZEN). B wants that test run excluded from the
// headline live-P&L so the "real money" number is not dragged by a known test,
// while keeping the data visible and labelled.
// ─────────────────────────────────────────────────────────────────────────────

export interface DisplayExclusion {
  /** lane column value in prediction_trades.db */
  lane: string;
  /** paper_mode value: 0 = real money, 1 = paper. */
  paper_mode: 0 | 1;
  /** short label shown in the UI next to the excluded figure */
  label: string;
  /** longer reason, shown on hover / in the per-strategy breakdown */
  reason: string;
}

// Each entry identifies a (lane, paper_mode) group to exclude from the displayed
// LIVE-money P&L total. Add/remove entries here — no data is ever touched.
export const LIVE_PNL_DISPLAY_EXCLUSIONS: DisplayExclusion[] = [
  {
    lane: 'btc',
    paper_mode: 0,
    label: 'test run — excluded',
    reason:
      'Sidewinder / Kalshi BTC real-money TEST run (band edge killed OOS, trading frozen). ~-$21 fee-driven loss. Excluded from displayed live-P&L; data intact.',
  },
];

/** True if this (lane, paper_mode) group is a display-excluded test run. */
export function isLivePnlExcluded(lane: string, paperMode: number): boolean {
  return LIVE_PNL_DISPLAY_EXCLUSIONS.some(
    (e) => e.lane === lane && e.paper_mode === paperMode,
  );
}

/** The exclusion record for a group, or null. */
export function getLivePnlExclusion(
  lane: string,
  paperMode: number,
): DisplayExclusion | null {
  return (
    LIVE_PNL_DISPLAY_EXCLUSIONS.find(
      (e) => e.lane === lane && e.paper_mode === paperMode,
    ) ?? null
  );
}

/**
 * SQL fragment (no params) that is TRUE for rows that should be EXCLUDED from the
 * displayed live-P&L. Use inside a CASE/WHERE. Empty exclusions → constant false.
 * Note: only paper_mode=0 entries affect a "live P&L" query, but the predicate is
 * built generically so it is correct for any query it is dropped into.
 */
export function excludedRowsSql(): string {
  if (LIVE_PNL_DISPLAY_EXCLUSIONS.length === 0) return '(0)';
  const clauses = LIVE_PNL_DISPLAY_EXCLUSIONS.map(
    (e) => `(lane = '${e.lane.replace(/'/g, "''")}' AND paper_mode = ${e.paper_mode})`,
  );
  return `(${clauses.join(' OR ')})`;
}
