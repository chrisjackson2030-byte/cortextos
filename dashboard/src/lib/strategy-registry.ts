// Curated registry of edge-hunt LEADS — the strategies/ideas tried that are NOT live/paper
// DB lanes (those come from /api/strategy-performance). This is the "count everything +
// graveyard" data B asked to always see (B-Model redesign #1 missing).
//
// POLICY (B, 2026-06-04): BACKTEST EVERYTHING TESTABLE. Pruning-by-reasoning risks killing
// the non-obvious edge we hunt for, so my judgment is no longer a kill switch. The only
// non-backtest exits are: (a) BLOCKED — no testable data exists yet (instrument too young /
// no usable history); (b) a literal duplicate of an already-run backtest. Everything else
// gets a real funnel run. kill_type='backtested' = ran the funnel, failed on data.

export type LeadStage = 'killed' | 'backtesting' | 'queued' | 'blocked' | 'research';

export interface HuntLead {
  name: string;
  stage: LeadStage;
  reason: string;
  date: string;
  category: string;
  kill_type?: 'backtested'; // only on killed entries; all kills are now backtested
}

export const HUNT_LEADS: HuntLead[] = [
  // ── KILLED — ran the full funnel, failed on data ──
  { name: 'Favorite-longshot taker (crypto)', stage: 'killed', kill_type: 'backtested', reason: 'Efficient; loses after fees.', date: '2026-06-03', category: 'crypto' },
  { name: 'KXBTCD multi-strike monotonicity arb', stage: 'killed', kill_type: 'backtested', reason: '3 / 29,462 timestamps had any locked arb (all <1c, 0 held-out). Ladder efficient.', date: '2026-06-03', category: 'crypto' },
  { name: 'Maker / taker gap (crypto)', stage: 'killed', kill_type: 'backtested', reason: 'Maker expectancy negative after slippage; "best decile" was a hot streak.', date: '2026-06-03', category: 'microstructure' },
  { name: 'Politics favorite-underpricing', stage: 'killed', kill_type: 'backtested', reason: 'Underpowered OOS; 2 powered cells FAIL (favorites OVERpriced).', date: '2026-06-03', category: 'politics' },
  { name: 'Polymarket NegRisk basket arb', stage: 'killed', kill_type: 'backtested', reason: '0 / 499 baskets had a fillable sum<1−fees arb; depth/gas/persistence kill it.', date: '2026-06-03', category: 'cross-venue' },
  { name: 'On-chain copy-trade', stage: 'killed', kill_type: 'backtested', reason: 'REJECTED, survives=false (high-quality null).', date: '2026-06-03', category: 'crypto' },
  { name: 'Kronos forecasting (BTC)', stage: 'killed', kill_type: 'backtested', reason: "Forecast didn't beat Kalshi implied OOS; survives=false (sandboxed).", date: '2026-06-03', category: 'crypto' },
  { name: 'Weather uncertainty over-pricing (KXHIGH)', stage: 'killed', kill_type: 'backtested', reason: 'Market CALIBRATED (Brier 0.081); body edge +0.000 after fees, held-out.', date: '2026-06-04', category: 'weather' },

  // ── QUEUED — re-opened for a real backtest (backtest-everything policy 2026-06-04; were pruned-by-reasoning) ──
  { name: '0DTE-momentum / OFI / macro-liquidity / stablecoin-mint', stage: 'queued', reason: 'Re-queued (was pruned "priced-in/beta") — backtest it; might surprise. Crypto data in hand.', date: '2026-06-04', category: 'crypto' },
  { name: 'Failed-break retest fade (BTC)', stage: 'queued', reason: 'Re-queued (was pruned as conditioned strike-magnet) — test the conditioned version; caveat sub-minute ~43% reconstructable.', date: '2026-06-04', category: 'crypto' },
  { name: 'Time-of-day liquidity-handoff (BTC 15m)', stage: 'queued', reason: 'Re-queued (was pruned "execution cost not edge") — backtest with the 1.9M BTC15m trades, model the spread.', date: '2026-06-04', category: 'crypto' },
  { name: 'Polymarket residual-vol seller (fee-portability)', stage: 'queued', reason: 'Re-queued (was pruned "Poly fee ≈ Kalshi") — backtest under both fee models; might surprise. Needs Poly pull.', date: '2026-06-04', category: 'cross-venue' },
  { name: 'Macro nowcast / revision-risk', stage: 'queued', reason: 'Re-queued (was pruned "macro efficient") — backtest the narrow revision-sensitive subfamily; free FRED/ALFRED.', date: '2026-06-04', category: 'macro' },
  { name: 'Cross-market disagreement (Kalshi↔Poly)', stage: 'queued', reason: 'Re-queued (was pruned "mapping/latency") — backtest where mapping is clean; might surprise.', date: '2026-06-04', category: 'cross-venue' },
  { name: 'Political elite-signal divergence', stage: 'queued', reason: 'Re-queued (was pruned "rare/hindsight") — backtest with strict held-out; flag tiny-n.', date: '2026-06-04', category: 'politics' },
  { name: 'Polymarket politics 1-day reversal', stage: 'queued', reason: 'Documented 58% negative serial correlation (2024); fragile — queued for funnel.', date: '2026-06-04', category: 'politics' },
  { name: 'KXINX S&P-500 range buckets', stage: 'queued', reason: 'Untested true-bucket structure (KXBTCD was a ladder); cheap null-check.', date: '2026-06-04', category: 'equity' },
  { name: 'Maker body-only (non-crypto)', stage: 'queued', reason: 'Crypto version killed — backtest non-crypto with real rebate schedule.', date: '2026-06-04', category: 'microstructure' },

  // ── KILLED tonight (cont.) ──
  { name: 'End-of-month/quarter close-pressure (equity-index)', stage: 'killed', kill_type: 'backtested', reason: 'KXINX 2022-26, 1.07M prints, 40 month-ends. Lean +0.08 ONLY at close-30m (flips neg at -15/-10m) + 98% of P&L from 2024 (2023 negative) + test_n=16<30. Overfit, fails 3 kill conditions.', date: '2026-06-04', category: 'equity' },

  // ── BLOCKED — no testable data yet (NOT a judgment kill; revive when data exists) ──
  { name: 'Post-event vol-crush (BTC binaries, CPI/FOMC)', stage: 'blocked', reason: 'No testable history: only fitting series (hourly KXBTCD) launched ~Apr 2026 → ~5 occasions < 30. Forward-collect; re-test ~2027.', date: '2026-06-04', category: 'crypto' },
  { name: 'Hurricane path uncertainty-collapse lag', stage: 'blocked', reason: 'No usable Kalshi storm history + poor liquidity. Revive if multi-season data + liquidity appear.', date: '2026-06-04', category: 'weather' },
  { name: 'Seasonal energy/weather-demand crossover', stage: 'blocked', reason: 'Sparse market coverage + heavy data-integration; not testable now.', date: '2026-06-04', category: 'weather' },
  { name: 'Weather last-bad-run overpricing', stage: 'blocked', reason: 'Needs a run-to-run forecast archive (consensus dispersion over time) we don’t store — would be hindsight. Forward-collect to revive.', date: '2026-06-04', category: 'weather' },

  // ── RESEARCH / DATA-GATED ──
  { name: 'Cross-venue settlement divergence', stage: 'research', reason: 'Real but rare / labor-heavy; resolution-rules audit, not a bot.', date: '2026-06-04', category: 'cross-venue' },
  { name: 'Sports cross-venue devig', stage: 'blocked', reason: 'Promising non-crypto lane but blocked on a sharp odds feed (paid data — B decides).', date: '2026-06-03', category: 'sports' },
];
