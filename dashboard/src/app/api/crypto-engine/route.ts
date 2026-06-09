import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// Crypto/Futures edge-engine dashboard data (B 2026-06-04). READ-ONLY of the
// crypto-edge-engine outputs. This is the NEW low-fee continuous-market hunt
// (Lil-Fish-style) running alongside prediction markets. Honest by construction:
// shows the edge-hunt scoreboard incl. the graveyard of killed candidates.
// No money, no live execution — paper/research.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.join(process.env.HOME ?? '/Users/chrisjackson', 'cortextos-data/crypto-engine');
const SCAN = path.join(ROOT, 'scan_candidates.json');
const REDTEAM = path.join(ROOT, 'redteam_verdicts.json');

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Freshness (B 2026-06-08): the crypto-engine scanner was RETIRED (superseded by the unified
// edge-engine) and scan_candidates.json has been silently stale — surface the source file's
// mtime + a stale flag so the page can never show a 4-day-old count as if it were live.
function fileMtimeIso(p: string): string | null {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // a count older than ~1 day is stale

export async function GET(_req: NextRequest) {
  const scan = readJson(SCAN);
  const rt = readJson(REDTEAM);
  if (!scan && !rt) {
    return Response.json({ available: false, reason: 'crypto-engine has not produced outputs yet' });
  }

  const sourceMtime = fileMtimeIso(SCAN) ?? fileMtimeIso(REDTEAM);
  const stale = sourceMtime ? (Date.now() - Date.parse(sourceMtime)) > STALE_AFTER_MS : true;

  const asText = (x: any): string | null =>
    x == null ? null : typeof x === 'string' ? x : JSON.stringify(x);

  const verdicts = (rt?.verdicts ?? []).map((v: any) => ({
    rank: v.rank,
    strategy: v.strategy,
    asset: v.asset,
    timeframe: v.timeframe,
    variant: v.variant,
    heldout_net_r: v.heldout_net_r,
    heldout_trades: v.heldout_trade_count,
    t_stat: v.approx_t_stat,
    real: !!v.real,
    reason: v.reason,
  }));
  const survivors = verdicts.filter((v: any) => v.real).length;

  // ── Strategy funnel (B 2026-06-05): the edge-hunt as a decreasing-stage
  // pipeline so the "0 survivors" story reads at a glance. All figures are real,
  // pulled straight from the scan + red-team summary (no fabrication).
  const rtSummary = rt?.summary ?? {};
  const tried = scan?.tried_count ?? null;
  const cleared = scan?.cleared_count ?? null; // passed min-trades / usable sample
  const discoveryPassed = rtSummary.count_gt_1_96 ?? null; // beat naive t > 1.96
  const validationPassed = rtSummary.count_gt_bonferroni ?? null; // beat multiple-testing bar
  const funnel = [
    { stage: 'Configs tried', value: tried, hint: 'every strategy/asset/variant generated' },
    { stage: 'Usable sample', value: cleared, hint: '>=30 held-out trades to score honestly' },
    { stage: 'Discovery passed', value: discoveryPassed, hint: 'beat naive significance (t > 1.96)' },
    { stage: 'Validation passed', value: validationPassed, hint: `beat multiple-testing bar (t > ${rtSummary.bonferroni_like_bar ?? '?'})` },
    { stage: 'Proven survivors', value: survivors, hint: 'promotion-ready edge' },
  ].filter((s) => s.value != null);

  return Response.json({
    available: true,
    source_mtime: sourceMtime,
    stale,
    retired: true, // crypto-engine scanner superseded by the unified edge-engine (see /edge-engine)
    summary: {
      proven: survivors > 0,
      status: survivors > 0 ? 'EDGE FOUND' : 'HUNTING — 0 PROVEN',
      tried,
      recorded: scan?.recorded_count ?? null,
      cleared,
      survivors,
      funnel,
      max_t_stat: rtSummary.max_approx_t_stat ?? null,
      bonferroni_bar: rtSummary.bonferroni_like_bar ?? null,
      scan_version: scan?.scan_version ?? null,
      generated_utc: rt?.generated_utc ?? scan?.generated_utc ?? null,
      data_source: scan?.data_source ?? 'Binance 1h spot',
      fee_per_side: scan?.fee_per_side ?? null,
      walk_forward: scan?.walk_forward ?? null,
      note:
        survivors === 0
          ? 'No proven edge yet — every candidate killed by the red-team (data-snooping / fees / multiple-testing). The relentless loop continues on the right low-fee venue.'
          : null,
    },
    structural_findings: (rt?.structural_findings ?? []).map(asText).filter(Boolean),
    iteration_focus: asText(rt?.iteration_focus),
    redteam_summary: asText(rt?.summary),
    candidates: verdicts,
  });
}
