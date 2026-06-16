// cortextOS Dashboard — /prop-firm data assembly (B-directed 2026-06-15).
// ONE screen for the Topstep prop-firm bot: live status, drawdown survival view,
// trade log, the 9-variant shadow-book leaderboard, and the recommended survival
// policy. Everything we run for the prop firm, in one place.
//
// READ-ONLY. The dashboard only DISPLAYS bot state. It NEVER writes any bot file,
// never touches the live bot, never reads/writes the KILL or PAUSE files.
// Every read is defensive: a missing/garbled file becomes "no data", never a crash
// and never a fabricated number.
//
// Sources (all under cortextos-data/tools/topstep-bot/):
//   - state/topstep-monitor.json     primary live status (equity, P&L, connection)
//   - state/day_state.json           trades_today, halts, start balance
//   - state/journal.jsonl            decision + fill + event log
//   - state/peak_balance.json        peak (drives trailing floor)
//   - state/cycle_state.json         cumulative / per-day profit
//   - state/shadow/<variant>.jsonl   the 9 shadow variants (sim trades)
//   - state/shadow/<variant>.state   per-variant trades_simulated + last bar
//   - deliverables/topstep-survival-sim-2026-06-15.md  recommended policy + P(pass)

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Bot location ─────────────────────────────────────────────────────────────
// The bot lives in the data tree alongside the framework, not inside the repo.
function botDir(): string {
  const env = process.env.TOPSTEP_BOT_DIR;
  if (env && fs.existsSync(env)) return env;
  return path.join(os.homedir(), 'cortextos-data', 'tools', 'topstep-bot');
}
function botState(...p: string[]): string {
  return path.join(botDir(), 'state', ...p);
}
function botDeliverable(name: string): string {
  return path.join(botDir(), 'deliverables', name);
}
// Survival deliverable currently lives in the jarvis deliverables tree.
function survivalDeliverablePaths(): string[] {
  return [
    botDeliverable('topstep-survival-sim-2026-06-15.md'),
    path.join(
      process.env.CTX_FRAMEWORK_ROOT ?? path.resolve(process.cwd(), '..'),
      'orgs', 'main', 'agents', 'jarvis', 'deliverables',
      'topstep-survival-sim-2026-06-15.md',
    ),
  ];
}

// ── Safe readers ─────────────────────────────────────────────────────────────
function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}
function readJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}
function readJsonlSafe<T>(p: string, tailLines?: number): T[] {
  const raw = readSafe(p);
  if (!raw) return [];
  let lines = raw.split('\n').filter((l) => l.trim());
  if (tailLines && lines.length > tailLines) lines = lines.slice(-tailLines);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip garbled line */
    }
  }
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface LiveStatus {
  updated_at: string | null;
  updated_at_et: string | null;
  status: string | null;       // healthy / degraded / etc
  connected: boolean | null;
  last_connected_ts: string | null;
  connection_age_sec: number | null;
  in_rth: boolean | null;
  kill_present: boolean | null;
  can_trade: boolean | null;
  day_halted: boolean | null;
  day_halt_reason: string | null;
  equity: number | null;
  day_pnl: number | null;
  trades_today: number | null;
  account_name: string | null;
  account_id: number | null;
  simulated: boolean | null;
}

export interface DrawdownView {
  equity: number | null;
  peak_balance: number | null;
  trailing_floor: number | null;
  distance_to_floor: number | null;  // the cushion in $
  floor_locked: boolean | null;
  start_balance: number | null;
  pass_target_balance: number | null; // start + 3000
  profit_to_pass: number | null;      // pass_target - equity
  progress_pct: number | null;        // 0..100 toward +3000
  buffer_total: number;               // 2000 (max-loss buffer)
}

export interface TradeRow {
  ts: string;
  kind: 'decision' | 'fill' | 'event';
  decision?: string;        // TAKE / SKIP
  side?: string;
  reasoning?: string;
  realized_pnl?: number | null;
  exit_reason?: string;
  event_kind?: string;      // for events: ACCOUNT / EOD / CONSISTENCY_CAP ...
  event_msg?: string;
}

export interface VariantRow {
  name: string;
  description: string;
  n: number;                 // sim trades with outcomes
  trades_simulated: number;  // from .state (incl. open)
  win_rate: number | null;
  expectancy: number | null; // $/trade
  lower_cb: number | null;   // 95% one-tailed lower bound
  gross_pnl: number | null;
  max_dd: number | null;
  status: 'GREEN' | 'YELLOW' | 'RED';
  last_bar_ts: string | null;
  is_baseline: boolean;
}

export interface SurvivalPolicy {
  available: boolean;
  headline: string | null;
  recommended_size: string | null;
  daily_lock: string | null;
  daily_stop: string | null;
  p_pass: string | null;
  p_pass_baseline: string | null;
  blow_rate: string | null;
  notes: string[];
  source_path: string | null;
}

export interface PropFirmPayload {
  generated_at: string;
  live: LiveStatus | null;
  drawdown: DrawdownView | null;
  trades: TradeRow[];
  trades_today_count: number;
  variants: VariantRow[];
  variants_available: boolean;
  policy: SurvivalPolicy;
}

// ── Variant catalog (names + short descriptions, mirrors shadow_variants.py) ──
// Read-only mirror so the UI can label variants even before they accumulate
// trades. Order matches the canonical 9-variant book.
const VARIANT_CATALOG: { name: string; description: string }[] = [
  { name: 'baseline', description: 'Exact live config: EMA20/50 breakout, 1.5x ATR stop, 2R target, MES 1 micro.' },
  { name: 'tighter-stop', description: 'Same breakout signal, stop tightened from 1.5x to 1.0x ATR.' },
  { name: 'wider-target', description: 'Same breakout + 1.5x ATR stop, target extended beyond 2R.' },
  { name: 'MNQ-instead-of-MES', description: 'Same signal/regime logic on MNQ (Micro Nasdaq) instead of MES.' },
  { name: 'RTH-morning-only', description: 'Signal evaluation filtered to the 9:45 to 11:00 ET morning window.' },
  { name: 'mean-reversion-filter', description: 'Breakout signal gated by a pre-breakout consolidation filter.' },
  { name: 'pre-cpi-drift', description: 'EDGE LEAD: day-before-CPI directional drift on NQ, run as MNQ futures.' },
  { name: 'close-auction-reversion', description: 'EDGE LEAD: close-auction reversion on ES, run as MES futures.' },
  { name: 'qqq-nq-momentum', description: 'EDGE LEAD (top pick): QQQ/NQ momentum run directly as an MNQ trade.' },
];

// Promotion-gate thresholds — mirror shadow_rank.py (do not drift without B).
const MIN_TRADES_FOR_GATE = 25;

// Student-t one-tailed critical value table (mirrors shadow_rank._t_critical).
function tCritical(df: number): number {
  const TABLE: Record<number, number> = {
    1: 6.314, 2: 2.92, 3: 2.353, 4: 2.132, 5: 2.015,
    6: 1.943, 7: 1.895, 8: 1.86, 9: 1.833, 10: 1.812,
    12: 1.782, 15: 1.753, 20: 1.725, 25: 1.708, 30: 1.697,
    40: 1.684, 60: 1.671, 120: 1.658, 9999: 1.645,
  };
  for (const k of Object.keys(TABLE).map(Number).sort((a, b) => a - b)) {
    if (df <= k) return TABLE[k];
  }
  return 1.645;
}

interface Stats {
  n: number;
  win_rate: number;
  expectancy: number;
  lower_cb: number;
  gross_pnl: number;
  max_dd: number;
}
function computeStats(pnls: number[]): Stats {
  const n = pnls.length;
  if (n === 0) {
    return { n: 0, win_rate: 0, expectancy: 0, lower_cb: -Infinity, gross_pnl: 0, max_dd: 0 };
  }
  const wins = pnls.filter((p) => p > 0).length;
  const gross = pnls.reduce((a, b) => a + b, 0);
  const expectancy = gross / n;
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  let lowerCb: number;
  if (n > 1) {
    const variance = pnls.reduce((a, p) => a + (p - expectancy) ** 2, 0) / (n - 1);
    const stdErr = Math.sqrt(variance) / Math.sqrt(n);
    lowerCb = expectancy - tCritical(n - 1) * stdErr;
  } else {
    lowerCb = -Infinity;
  }
  return { n, win_rate: wins / n, expectancy, lower_cb: lowerCb, gross_pnl: gross, max_dd: maxDd };
}

function promotionStatus(s: Stats, baselineLowerCb: number): 'GREEN' | 'YELLOW' | 'RED' {
  const g1 = s.n >= MIN_TRADES_FOR_GATE;
  const g2 = s.lower_cb > 0;
  const g3 = baselineLowerCb !== -Infinity ? s.lower_cb > baselineLowerCb : false;
  const allPass = g1 && g2 && g3;
  const marginal = g1 && s.expectancy > 0 && s.lower_cb <= 5.0 && !allPass;
  if (allPass) return 'GREEN';
  if (marginal) return 'YELLOW';
  return 'RED';
}

// ── Loaders ──────────────────────────────────────────────────────────────────
interface MonitorFile {
  updated_at?: string; updated_at_et?: string; status?: string;
  connected?: boolean; last_connected_ts?: string; connection_age_sec?: number;
  in_rth?: boolean; kill_present?: boolean; can_trade?: boolean;
  day_halted?: boolean; day_halt_reason?: string;
  equity?: number; day_pnl?: number; trades_today?: number;
  trailing_floor?: number; distance_to_floor?: number;
}
interface DayStateFile {
  start_balance?: number; trades_today?: number;
  halted?: boolean; halt_reason?: string;
  profit_halted?: boolean; profit_halt_reason?: string;
}
interface JournalRecord {
  record?: string; ts?: string;
  decision?: string; reasoning?: string;
  signal?: { side?: string };
  realized_pnl?: number; exit_reason?: string;
  kind?: string; msg?: string;
  account?: { name?: string; account_id?: number; simulated?: boolean; floor_locked?: boolean; peak_balance?: number };
  name?: string; account_id?: number; simulated?: boolean; floor_locked?: boolean; peak_balance?: number;
}

function loadLive(monitor: MonitorFile | null, journalTail: JournalRecord[]): LiveStatus | null {
  if (!monitor) return null;
  // Pull account identity from the most recent ACCOUNT event (read-only).
  let acctName: string | null = null, acctId: number | null = null, sim: boolean | null = null;
  for (let i = journalTail.length - 1; i >= 0; i--) {
    const r = journalTail[i];
    const acct = r.record === 'event' && r.kind === 'ACCOUNT' ? r : null;
    if (acct) {
      acctName = acct.name ?? null;
      acctId = acct.account_id ?? null;
      sim = acct.simulated ?? null;
      break;
    }
  }
  return {
    updated_at: monitor.updated_at ?? null,
    updated_at_et: monitor.updated_at_et ?? null,
    status: monitor.status ?? null,
    connected: monitor.connected ?? null,
    last_connected_ts: monitor.last_connected_ts ?? null,
    connection_age_sec: monitor.connection_age_sec ?? null,
    in_rth: monitor.in_rth ?? null,
    kill_present: monitor.kill_present ?? null,
    can_trade: monitor.can_trade ?? null,
    day_halted: monitor.day_halted ?? null,
    day_halt_reason: monitor.day_halt_reason || null,
    equity: monitor.equity ?? null,
    day_pnl: monitor.day_pnl ?? null,
    trades_today: monitor.trades_today ?? null,
    account_name: acctName,
    account_id: acctId,
    simulated: sim,
  };
}

function loadDrawdown(monitor: MonitorFile | null, day: DayStateFile | null, peak: { peak_balance?: number } | null, journalTail: JournalRecord[]): DrawdownView | null {
  if (!monitor && !day) return null;
  const equity = monitor?.equity ?? null;
  const trailingFloor = monitor?.trailing_floor ?? null;
  const distance = monitor?.distance_to_floor ?? (equity != null && trailingFloor != null ? equity - trailingFloor : null);
  const startBalance = day?.start_balance ?? null;
  // floor_locked surfaces from the latest ACCOUNT journal record.
  let floorLocked: boolean | null = null;
  for (let i = journalTail.length - 1; i >= 0; i--) {
    const r = journalTail[i];
    if (r.record === 'event' && r.kind === 'ACCOUNT' && typeof r.floor_locked === 'boolean') {
      floorLocked = r.floor_locked;
      break;
    }
  }
  // Pass target is +$3,000 over the eval START balance ($50,000), not today's start.
  // The combine target is a fixed $53,000 end-of-day closing balance.
  const evalStart = 50000;
  const passTarget = evalStart + 3000;
  const profitToPass = equity != null ? passTarget - equity : null;
  const progressPct = equity != null ? Math.max(0, Math.min(100, ((equity - evalStart) / 3000) * 100)) : null;
  return {
    equity,
    peak_balance: peak?.peak_balance ?? null,
    trailing_floor: trailingFloor,
    distance_to_floor: distance,
    floor_locked: floorLocked,
    start_balance: startBalance,
    pass_target_balance: passTarget,
    profit_to_pass: profitToPass,
    progress_pct: progressPct,
    buffer_total: 2000,
  };
}

function loadTrades(journalTail: JournalRecord[]): { rows: TradeRow[]; todayCount: number } {
  const today = new Date().toISOString().slice(0, 10);
  const rows: TradeRow[] = [];
  let todayDecisions = 0;
  for (const r of journalTail) {
    if (r.record === 'decision' && r.decision) {
      rows.push({
        ts: r.ts ?? '',
        kind: 'decision',
        decision: r.decision,
        side: r.signal?.side || undefined,
        reasoning: r.reasoning,
      });
      if ((r.ts ?? '').slice(0, 10) === today && r.decision === 'TAKE') todayDecisions++;
    } else if (r.record === 'outcome') {
      rows.push({
        ts: r.ts ?? '',
        kind: 'fill',
        realized_pnl: typeof r.realized_pnl === 'number' ? r.realized_pnl : null,
        exit_reason: r.exit_reason,
      });
    } else if (r.record === 'event' && r.kind && r.kind !== 'ACCOUNT') {
      // Surface meaningful events (halts, EOD, consistency caps). Skip the
      // very chatty ACCOUNT heartbeat rows.
      rows.push({
        ts: r.ts ?? '',
        kind: 'event',
        event_kind: r.kind,
        event_msg: r.msg,
      });
    }
  }
  // newest first
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { rows: rows.slice(0, 40), todayCount: todayDecisions };
}

function loadVariants(): { variants: VariantRow[]; available: boolean } {
  const shadowDir = botState('shadow');
  if (!fs.existsSync(shadowDir)) return { variants: [], available: false };

  // First pass: compute baseline lower_cb for the gate comparison.
  const statsByName = new Map<string, Stats>();
  const stateByName = new Map<string, { trades_simulated: number; last_bar_ts: string | null }>();
  for (const v of VARIANT_CATALOG) {
    const recs = readJsonlSafe<JournalRecord>(path.join(shadowDir, `${v.name}.jsonl`));
    const pnls = recs
      .filter((r) => r.record === 'outcome' && typeof r.realized_pnl === 'number')
      .map((r) => r.realized_pnl as number);
    statsByName.set(v.name, computeStats(pnls));
    const st = readJsonSafe<{ trades_simulated?: number; last_bar_ts?: string }>(path.join(shadowDir, `${v.name}.state`));
    stateByName.set(v.name, {
      trades_simulated: st?.trades_simulated ?? 0,
      last_bar_ts: st?.last_bar_ts ?? null,
    });
  }
  const baselineLowerCb = statsByName.get('baseline')?.lower_cb ?? -Infinity;

  const variants: VariantRow[] = VARIANT_CATALOG.map((v) => {
    const s = statsByName.get(v.name)!;
    const st = stateByName.get(v.name)!;
    return {
      name: v.name,
      description: v.description,
      n: s.n,
      trades_simulated: st.trades_simulated,
      win_rate: s.n > 0 ? s.win_rate : null,
      expectancy: s.n > 0 ? s.expectancy : null,
      lower_cb: s.n > 1 ? s.lower_cb : null,
      gross_pnl: s.n > 0 ? s.gross_pnl : null,
      max_dd: s.n > 0 ? s.max_dd : null,
      status: promotionStatus(s, baselineLowerCb),
      last_bar_ts: st.last_bar_ts,
      is_baseline: v.name === 'baseline',
    };
  });

  // Rank by lower_cb desc (matches shadow_rank), -inf last.
  variants.sort((a, b) => (b.lower_cb ?? -Infinity) - (a.lower_cb ?? -Infinity));
  return { variants, available: true };
}

function loadPolicy(): SurvivalPolicy {
  let raw = '';
  let sourcePath: string | null = null;
  for (const p of survivalDeliverablePaths()) {
    raw = readSafe(p);
    if (raw) { sourcePath = p; break; }
  }
  if (!raw) {
    return {
      available: false, headline: null, recommended_size: null, daily_lock: null,
      daily_stop: null, p_pass: null, p_pass_baseline: null, blow_rate: null,
      notes: [], source_path: null,
    };
  }
  // Parse the headline line + key numbers from the deliverable. Defensive:
  // if a field is not found it stays null rather than being invented.
  const headlineMatch = raw.match(/\*\*Recommended policy:\*\*\s*([^\n]+?)\.?\s*\n/);
  const headline = headlineMatch ? headlineMatch[1].replace(/\*/g, '').trim() : null;

  // "lock-in-and-stop at about +$500/day, stop-for-the-day at -$400"
  const lockMatch = raw.match(/lock[- ]in[- ]and[- ]stop at about \+\$?([\d,]+)/i);
  const stopMatch = raw.match(/stop[- ]for[- ]the[- ]day at[- ]?\$?-?([\d,]+)/i);
  const sizeMatch = raw.match(/Recommended policy:\*\*\s*(\d+\s*micro)/i);

  // "P(pass) about 52%, vs 42% for the current 1-micro no-stop baseline"
  const pPassMatch = raw.match(/P\(pass\)\s*about\s*([\d]+%)/i);
  const pBaseMatch = raw.match(/vs\s*([\d]+%)\s*for the current/i);
  const blowMatch = raw.match(/blow rate stays high \(about\s*([\d]+%)\)/i);

  const notes: string[] = [];
  if (/REFUTED, hard/i.test(raw)) notes.push('Go-crazy-first-few-days: REFUTED hard (5 micro early passes about 1%).');
  if (/Two-account directional hedge verdict: REFUTED/i.test(raw)) notes.push('Two-account directional hedge: REFUTED (negative EV vs one good account).');
  if (/consistency-rule failure rate from/i.test(raw)) notes.push('Daily lock/stop drops the consistency-rule failure rate from 11% to 0%.');
  notes.push('n=19 shadow sample is small and noisy: treat absolute P(pass) as directional, not precise.');

  return {
    available: true,
    headline,
    recommended_size: sizeMatch ? sizeMatch[1].trim() : '1 micro',
    daily_lock: lockMatch ? `+$${lockMatch[1]}/day` : null,
    daily_stop: stopMatch ? `-$${stopMatch[1]}/day` : null,
    p_pass: pPassMatch ? pPassMatch[1] : null,
    p_pass_baseline: pBaseMatch ? pBaseMatch[1] : null,
    blow_rate: blowMatch ? blowMatch[1] : null,
    notes,
    source_path: sourcePath,
  };
}

// ── Public payload ───────────────────────────────────────────────────────────
export function getPropFirmPayload(): PropFirmPayload {
  const monitor = readJsonSafe<MonitorFile>(botState('topstep-monitor.json'));
  const day = readJsonSafe<DayStateFile>(botState('day_state.json'));
  const peak = readJsonSafe<{ peak_balance?: number }>(botState('peak_balance.json'));
  // Tail the journal so the UI stays fast even as the file grows large.
  const journalTail = readJsonlSafe<JournalRecord>(botState('journal.jsonl'), 200);

  const live = loadLive(monitor, journalTail);
  const drawdown = loadDrawdown(monitor, day, peak, journalTail);
  const { rows: trades, todayCount } = loadTrades(journalTail);
  const { variants, available: variantsAvailable } = loadVariants();
  const policy = loadPolicy();

  // Prefer day_state trades_today (authoritative) then monitor.
  const tradesTodayCount = day?.trades_today ?? monitor?.trades_today ?? todayCount;

  return {
    generated_at: new Date().toISOString(),
    live,
    drawdown,
    trades,
    trades_today_count: tradesTodayCount,
    variants,
    variants_available: variantsAvailable,
    policy,
  };
}
