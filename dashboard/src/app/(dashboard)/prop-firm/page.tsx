'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ─────────────────────────────────────────────────────────────────────────────
// /prop-firm — everything we run for the Topstep prop-firm bot, on one screen
// (B 2026-06-15). Mirrors the /revenue page pattern: client poll of
// /api/prop-firm every 30s, freshness surfaced, honest numbers only, no made-up
// data. READ-ONLY of the live bot. Order: live status, drawdown survival view,
// trade log, shadow-book leaderboard, recommended survival policy.
// ─────────────────────────────────────────────────────────────────────────────

interface LiveStatus {
  updated_at: string | null;
  updated_at_et: string | null;
  status: string | null;
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
interface DrawdownView {
  equity: number | null;
  peak_balance: number | null;
  trailing_floor: number | null;
  distance_to_floor: number | null;
  floor_locked: boolean | null;
  start_balance: number | null;
  pass_target_balance: number | null;
  profit_to_pass: number | null;
  progress_pct: number | null;
  buffer_total: number;
}
interface TradeRow {
  ts: string;
  kind: 'decision' | 'fill' | 'event';
  decision?: string;
  side?: string;
  reasoning?: string;
  realized_pnl?: number | null;
  exit_reason?: string;
  event_kind?: string;
  event_msg?: string;
}
interface VariantRow {
  name: string;
  description: string;
  n: number;
  trades_simulated: number;
  win_rate: number | null;
  expectancy: number | null;
  lower_cb: number | null;
  gross_pnl: number | null;
  max_dd: number | null;
  status: 'GREEN' | 'YELLOW' | 'RED';
  last_bar_ts: string | null;
  is_baseline: boolean;
}
interface SurvivalPolicy {
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
interface Payload {
  available: boolean;
  reason?: string;
  generated_at?: string;
  live?: LiveStatus | null;
  drawdown?: DrawdownView | null;
  trades?: TradeRow[];
  trades_today_count?: number;
  variants?: VariantRow[];
  variants_available?: boolean;
  policy?: SurvivalPolicy;
}

function relAge(iso?: string | null): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function usd(v: number | null | undefined, signed = false): string {
  if (v == null || Number.isNaN(v)) return 'no data';
  const sign = signed && v >= 0 ? '+' : '';
  return `${sign}$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: 'good' | 'bad' | 'accent' | 'warn'; sub?: string }) {
  const color =
    tone === 'good' ? 'text-emerald-400'
    : tone === 'bad' ? 'text-rose-400'
    : tone === 'warn' ? 'text-amber-300'
    : tone === 'accent' ? 'text-cyan-300'
    : 'text-zinc-100';
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.015] px-4 py-3 ring-1 ring-white/10 shadow-lg shadow-black/30">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function Flag({ label, on, onTone = 'good', offTone = 'bad', onText, offText }: {
  label: string; on: boolean | null; onTone?: 'good' | 'bad' | 'warn'; offTone?: 'good' | 'bad' | 'warn';
  onText?: string; offText?: string;
}) {
  if (on == null) {
    return (
      <div className="rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-white/10">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
        <div className="text-sm font-semibold text-zinc-500">no data</div>
      </div>
    );
  }
  const tone = on ? onTone : offTone;
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-rose-300';
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-white/10">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{on ? (onText ?? 'yes') : (offText ?? 'no')}</div>
    </div>
  );
}

const VARIANT_TONE: Record<string, string> = {
  GREEN: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/20',
  YELLOW: 'bg-amber-500/15 text-amber-300 ring-amber-400/20',
  RED: 'bg-rose-500/10 text-rose-300 ring-rose-400/20',
};

export default function PropFirmPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/prop-firm')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000); // bot updates monitor.json each cycle
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div className="p-6 text-sm text-rose-400">Failed to load prop-firm state: {err}</div>;
  if (!data) return <div className="p-6 text-sm text-zinc-500">Loading prop-firm state...</div>;
  if (!data.available) {
    return <div className="p-6 text-sm text-zinc-500">Prop-firm feed unavailable{data.reason ? ` (${data.reason})` : ''}.</div>;
  }

  const live = data.live ?? null;
  const dd = data.drawdown ?? null;
  const trades = data.trades ?? [];
  const variants = data.variants ?? [];
  const policy = data.policy;

  const connected = live?.connected ?? null;
  const dayPnl = live?.day_pnl ?? null;
  const cushion = dd?.distance_to_floor ?? null;
  // Cushion tone: green if comfortable, amber if thin, red if near the floor.
  const cushionTone = cushion == null ? 'accent' : cushion < 500 ? 'bad' : cushion < 1000 ? 'warn' : 'good';

  return (
    <div className="space-y-6 p-1">
      {/* Header + freshness */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Prop Firm (Topstep)</h1>
          <p className="text-xs text-zinc-500">
            Everything we run for the prop-firm bot on one screen. Auto-refreshes every 30s. Read-only, honest numbers only.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">monitor updated</div>
          <div className="text-xs tabular-nums text-zinc-300" title={live?.updated_at ?? undefined}>{relAge(live?.updated_at)}</div>
        </div>
      </div>

      {/* 1. LIVE STATUS BANNER */}
      <div className={`rounded-xl p-4 ring-1 ${
        live?.kill_present ? 'bg-rose-500/[0.08] ring-rose-400/30'
        : connected === false ? 'bg-rose-500/[0.06] ring-rose-400/25'
        : 'bg-white/[0.02] ring-white/10'
      }`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-semibold text-zinc-100">
            Live status
            {live?.account_name && (
              <span className="ml-2 text-xs font-normal text-zinc-500">
                {live.account_name}{live.simulated ? ' (sim eval)' : ''}
              </span>
            )}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            {live?.status ? `bot: ${live.status}` : 'bot status unknown'}
          </div>
        </div>

        {!live ? (
          <div className="mt-3 text-xs text-zinc-500">No monitor data on disk (topstep-monitor.json not found or unreadable).</div>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Equity" value={usd(live.equity)} tone="accent" />
              <Kpi label="Today P&amp;L" value={usd(dayPnl, true)} tone={(dayPnl ?? 0) >= 0 ? 'good' : 'bad'} />
              <Kpi label="Trades today" value={live.trades_today != null ? String(live.trades_today) : 'no data'} />
              <Kpi
                label="Connection"
                value={connected == null ? 'unknown' : connected ? 'LIVE' : 'DOWN'}
                tone={connected == null ? 'warn' : connected ? 'good' : 'bad'}
                sub={live.last_connected_ts ? `last ${relAge(live.last_connected_ts)}` : undefined}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              <Flag label="In RTH" on={live.in_rth} onTone="good" offTone="warn" onText="open" offText="closed" />
              <Flag label="Kill switch" on={live.kill_present} onTone="bad" offTone="good" onText="PRESENT" offText="clear" />
              <Flag label="Can trade" on={live.can_trade} onTone="good" offTone="warn" onText="yes" offText="no" />
              <Flag label="Day halted" on={live.day_halted} onTone="warn" offTone="good" onText="HALTED" offText="running" />
              <div className="rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-white/10">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Rules play</div>
                <div className="text-sm font-semibold text-zinc-300">
                  {live.day_halt_reason ? 'capped' : live.day_halted ? 'halted' : 'active'}
                </div>
              </div>
            </div>
            {live.day_halt_reason && (
              <p className="mt-2 text-[11px] text-amber-300/90">Halt reason: {live.day_halt_reason}</p>
            )}
          </>
        )}
      </div>

      {/* 2. DRAWDOWN / SURVIVAL VIEW */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Drawdown and survival</div>
        {!dd ? (
          <div className="rounded-xl bg-white/[0.02] p-4 text-xs text-zinc-500 ring-1 ring-white/10">No drawdown data on disk.</div>
        ) : (
          <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/10">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi
                label="Cushion to floor"
                value={usd(dd.distance_to_floor)}
                tone={cushionTone}
                sub={`buffer $${dd.buffer_total.toLocaleString()} total`}
              />
              <Kpi label="Trailing floor" value={usd(dd.trailing_floor)} sub={dd.floor_locked ? 'LOCKED' : 'trailing'} />
              <Kpi label="Peak balance" value={usd(dd.peak_balance)} />
              <Kpi
                label="To pass target"
                value={dd.profit_to_pass != null && dd.profit_to_pass > 0 ? usd(dd.profit_to_pass) : 'reached'}
                tone={dd.profit_to_pass != null && dd.profit_to_pass <= 0 ? 'good' : 'accent'}
                sub={dd.pass_target_balance ? `target ${usd(dd.pass_target_balance)}` : undefined}
              />
            </div>

            {/* Progress toward +$3,000 pass target */}
            <div className="mt-4">
              <div className="mb-1 flex items-baseline justify-between text-[11px] text-zinc-500">
                <span>Progress to pass (+$3,000 over $50,000 start)</span>
                <span className="tabular-nums text-zinc-400">
                  {dd.progress_pct != null ? `${dd.progress_pct.toFixed(1)}%` : 'no data'}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, dd.progress_pct ?? 0))}%` }}
                />
              </div>
            </div>

            {/* Floor cushion bar (how much room before a blow) */}
            <div className="mt-4">
              <div className="mb-1 flex items-baseline justify-between text-[11px] text-zinc-500">
                <span>Cushion remaining before trailing-floor breach (blow)</span>
                <span className="tabular-nums text-zinc-400">
                  {dd.distance_to_floor != null ? `${usd(dd.distance_to_floor)} of $${dd.buffer_total.toLocaleString()}` : 'no data'}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-all ${
                    cushionTone === 'bad' ? 'bg-rose-500' : cushionTone === 'warn' ? 'bg-amber-400' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${Math.max(0, Math.min(100, ((dd.distance_to_floor ?? 0) / dd.buffer_total) * 100))}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. TRADE LOG */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Trade log (recent decisions, fills, events)</div>
          <div className="text-[11px] text-zinc-500">{data.trades_today_count ?? 0} trades today</div>
        </div>
        <div className="overflow-hidden rounded-xl ring-1 ring-white/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-xs text-zinc-500">No journal entries found.</TableCell></TableRow>
              )}
              {trades.map((t, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-zinc-400" title={t.ts}>{relAge(t.ts)}</TableCell>
                  <TableCell className="text-xs">
                    {t.kind === 'decision' ? (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                        t.decision === 'TAKE'
                          ? 'bg-cyan-500/15 text-cyan-300 ring-cyan-400/20'
                          : 'bg-white/5 text-zinc-400 ring-white/10'
                      }`}>
                        {t.decision}{t.side ? ` ${t.side}` : ''}
                      </span>
                    ) : t.kind === 'fill' ? (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 bg-emerald-500/10 text-emerald-300 ring-emerald-400/20">FILL</span>
                    ) : (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 bg-amber-500/10 text-amber-300 ring-amber-400/20">{t.event_kind}</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[28rem] truncate text-xs text-zinc-400" title={t.reasoning ?? t.event_msg ?? t.exit_reason ?? ''}>
                    {t.kind === 'decision' ? (t.reasoning ?? '')
                      : t.kind === 'fill' ? (t.exit_reason ?? 'exit')
                      : (t.event_msg ?? '')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {t.kind === 'fill' && t.realized_pnl != null ? (
                      <span className={t.realized_pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{usd(t.realized_pnl, true)}</span>
                    ) : (
                      <span className="text-zinc-600">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 4. SHADOW BOOK LEADERBOARD */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Shadow book (9 variants, sim-only)</div>
          <div className="text-[11px] text-zinc-500">promote gate: n&gt;=25, lower-CB&gt;0, beats baseline. RED until proven.</div>
        </div>
        {!data.variants_available ? (
          <div className="rounded-xl bg-white/[0.02] p-4 text-xs text-zinc-500 ring-1 ring-white/10">Shadow directory not found.</div>
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">N</TableHead>
                  <TableHead className="text-right">Win</TableHead>
                  <TableHead className="text-right">Expect</TableHead>
                  <TableHead className="text-right">Lower CB</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Max DD</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {variants.map((v) => (
                  <TableRow key={v.name}>
                    <TableCell className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-zinc-200">{v.name}</span>
                        {v.is_baseline && <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] text-zinc-500 ring-1 ring-white/10">LIVE</span>}
                      </div>
                      <div className="max-w-[24rem] truncate text-[11px] text-zinc-600" title={v.description}>{v.description}</div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-300" title={`${v.trades_simulated} simulated incl. open`}>{v.n}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-400">{v.win_rate != null ? `${(v.win_rate * 100).toFixed(0)}%` : '-'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-400">{v.expectancy != null ? usd(v.expectancy, true) : '-'}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${v.lower_cb != null && v.lower_cb > 0 ? 'text-emerald-300' : 'text-zinc-400'}`}>{v.lower_cb != null ? usd(v.lower_cb, true) : '-'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-400">{v.gross_pnl != null ? usd(v.gross_pnl, true) : '-'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-zinc-500">{v.max_dd != null ? `$${v.max_dd.toFixed(0)}` : '-'}</TableCell>
                    <TableCell>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${VARIANT_TONE[v.status]}`}>{v.status}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-600">
          Ranked by 95% lower confidence bound on expectancy. Simulated P&amp;L is not live P&amp;L. No variant promotes without B.
        </p>
      </div>

      {/* 5. SURVIVAL POLICY CARD */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Recommended survival policy</div>
        {!policy?.available ? (
          <div className="rounded-xl bg-white/[0.02] p-4 text-xs text-zinc-500 ring-1 ring-white/10">Survival sim deliverable not found.</div>
        ) : (
          <div className="rounded-xl bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-4 ring-1 ring-white/10">
            {policy.headline && <p className="text-sm text-zinc-200">{policy.headline}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Size" value={policy.recommended_size ?? 'no data'} tone="accent" />
              <Kpi label="Daily lock" value={policy.daily_lock ?? 'no data'} tone="good" />
              <Kpi label="Daily stop" value={policy.daily_stop ?? 'no data'} tone="warn" />
              <Kpi
                label="P(pass)"
                value={policy.p_pass ?? 'no data'}
                tone="good"
                sub={policy.p_pass_baseline ? `vs ${policy.p_pass_baseline} baseline` : undefined}
              />
            </div>
            {policy.blow_rate && (
              <p className="mt-3 text-[11px] text-zinc-500">Blow rate stays about {policy.blow_rate} at any size (thin edge, small sample).</p>
            )}
            {policy.notes.length > 0 && (
              <ul className="mt-2 space-y-1">
                {policy.notes.map((n, i) => (
                  <li key={i} className="text-[11px] text-zinc-500">- {n}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <p className="text-[10px] text-zinc-600">
        Feed generated {relAge(data.generated_at)}. Display only. This page never writes bot state, never touches the live bot.
      </p>
    </div>
  );
}
