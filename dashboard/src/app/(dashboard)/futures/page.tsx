'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Futures/Crypto edge-engine dashboard (B 2026-06-04, rebuilt per dashboard-design skill).
// 4-zone IA: header · KPI strip · hero scoreboard viz · evidence (findings + table).
// Dark blue-gray discipline, one electric accent, semantic red/green for verdicts.

const ACCENT = '#22d3ee';
const GOOD = '#34d399';
const BAD = '#fb7185';

interface Candidate {
  rank: number;
  strategy: string;
  asset: string;
  timeframe: string;
  variant: string;
  heldout_net_r: number | null;
  heldout_trades: number | null;
  t_stat: number | null;
  real: boolean;
  reason: string;
}
interface Data {
  available: boolean;
  reason?: string;
  source_mtime?: string | null;
  stale?: boolean;
  retired?: boolean;
  summary?: {
    proven: boolean;
    status: string;
    tried: number | null;
    recorded: number | null;
    cleared: number | null;
    survivors: number;
    funnel?: { stage: string; value: number; hint: string }[];
    max_t_stat?: number | null;
    bonferroni_bar?: number | null;
    data_source: string;
    fee_per_side: number | null;
    generated_utc: string | null;
    note: string | null;
  };
  structural_findings?: string[];
  iteration_focus?: string | null;
  redteam_summary?: string | null;
  candidates?: Candidate[];
}

interface LiveForwardPaperConfig {
  config_id: string;
  paper_trades: number;
  position: string;
  last_signal: string;
  last_action: string;
  win_pct: number | null;
  net_r: number | null;
  updated_utc: string | null;
}

interface LiveForwardData {
  available: boolean;
  reason?: string;
  generated_utc?: string | null;
  realMoney?: {
    mode: string;
    live_equity_usd: number;
    starting_equity_usd: number;
    cumulative_realized_pnl: number;
    budget_usd: number;
    kill_line_usd: number;
    halted: boolean;
    position: unknown;
    position_label: string;
    last_event: {
      kind?: string;
      action?: string;
      ts?: number;
    } | null;
    last_action: string;
  } | null;
  paperCluster?: LiveForwardPaperConfig[];
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'accent' }) {
  const color =
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : tone === 'accent' ? 'text-cyan-300' : 'text-zinc-100';
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.015] px-4 py-3 ring-1 ring-white/10 shadow-lg shadow-black/30">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function formatUsd(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '--';
  return `$${value.toFixed(2)}`;
}

function formatSignedR(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} R`;
}

export default function FuturesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [liveForward, setLiveForward] = useState<LiveForwardData | null>(null);

  const fetchData = useCallback(() => {
    fetch('/api/crypto-engine')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  const fetchLiveForward = useCallback(() => {
    fetch('/api/live-forward')
      .then((r) => r.json())
      .then(setLiveForward)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchData();
    fetchLiveForward();
    const id = setInterval(() => {
      fetchData();
      fetchLiveForward();
    }, 60_000);
    return () => clearInterval(id);
  }, [fetchData, fetchLiveForward]);

  if (!data)
    return <div className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />;
  if (!data.available)
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm text-zinc-400">
        Crypto/futures engine: {data.reason}
      </div>
    );

  const s = data.summary!;
  const cands = data.candidates ?? [];
  const bonfBar = s.bonferroni_bar ?? null;
  // Top candidates only (top 8 by held-out R) — readable, not a 16-bar wall.
  // Color discipline: green = proven survivor; cyan = cleared discovery (t>1.96);
  // muted = killed early. Red is reserved for genuinely negative held-out R.
  const chartData = [...cands]
    .filter((c) => c.heldout_net_r != null)
    .sort((a, b) => (b.heldout_net_r ?? 0) - (a.heldout_net_r ?? 0))
    .slice(0, 8)
    .map((c) => {
      const t = c.t_stat ?? 0;
      const verdict: 'survivor' | 'discovery' | 'killed' | 'negative' = c.real
        ? 'survivor'
        : (c.heldout_net_r ?? 0) < 0
          ? 'negative'
          : t >= 1.96
            ? 'discovery'
            : 'killed';
      return {
        label: `${c.asset.replace('USDT', '')} · ${c.strategy.replace(/_/g, ' ')}`.slice(0, 26),
        value: c.heldout_net_r ?? 0,
        t,
        verdict,
        trades: c.heldout_trades,
      };
    });
  // Funnel stages (decreasing) — the hero story: many tried, few survive.
  const funnel = s.funnel ?? [];
  const funnelMax = funnel.length ? Math.max(...funnel.map((f) => f.value)) : 0;
  const verdictFill: Record<string, string> = {
    survivor: GOOD,
    discovery: ACCENT,
    killed: '#52525b',
    negative: BAD,
  };
  const paperRows = liveForward?.paperCluster ?? [];
  const paperChartData = [...paperRows]
    .sort((a, b) => (b.net_r ?? -999) - (a.net_r ?? -999))
    .map((row) => ({
      label: row.config_id.replace(/_/g, ' ').slice(0, 24),
      value: row.net_r ?? 0,
    }));
  const liveProbe = liveForward?.realMoney ?? null;
  const livePnl = liveProbe ? liveProbe.live_equity_usd - liveProbe.starting_equity_usd : null;

  return (
    <div className="space-y-5">
      {/* Staleness banner (B 2026-06-08): the crypto-engine scanner was RETIRED — surface the
          source file's age so a 4-day-old count can never read as live, + point to the live unified view. */}
      {data?.available && (data.stale || data.retired) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <div className="text-xs text-amber-200">
            ⚠️ Legacy crypto-engine scanner — retired & superseded by the unified Edge Engine.
            {data.source_mtime ? ` Counts below are STALE (as of ${new Date(data.source_mtime).toLocaleString()}), not live.` : ' Counts below may be stale, not live.'}
          </div>
          <a href="/edge-engine" className="shrink-0 rounded-lg bg-amber-400/20 px-3 py-1 text-xs font-semibold text-amber-100 ring-1 ring-amber-300/30 hover:bg-amber-400/30">
            → Live Edge Engine
          </a>
        </div>
      )}
      {/* Zone 1 — header / command bar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Futures / Crypto Edge Engine</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Low-fee continuous-market hunt · paper/research, no money · Claude proposes, the funnel decides
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wider ${
            s.proven
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          }`}
        >
          {s.status}
        </span>
      </div>

      <div className="rounded-2xl border border-cyan-400/15 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 shadow-lg shadow-black/30 ring-1 ring-white/8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-zinc-100">Live Forward-Tests</h2>
              <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-cyan-300">
                LIVE
              </span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Real-money SHIB probe plus four paper cluster configs · refreshes every 60s
            </p>
          </div>
          {liveForward?.generated_utc && (
            <div className="text-[11px] text-zinc-500">Updated {new Date(liveForward.generated_utc).toLocaleString()}</div>
          )}
        </div>

        {!liveForward ? (
          <div className="h-48 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
        ) : !liveForward.available || !liveProbe ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-400">
            Live forward-tests unavailable: {liveForward.reason ?? 'no feed yet'}
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.015] p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-cyan-300">Real-Money Probe</div>
                  <h3 className="mt-1 text-lg font-semibold tracking-tight text-zinc-100">SHIB Kraken</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.16em] text-emerald-300">
                    {liveProbe.halted ? 'HALTED' : String(liveProbe.mode).toUpperCase()}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Kpi label="Equity" value={formatUsd(liveProbe.live_equity_usd)} tone="accent" />
                <Kpi label="P&L" value={formatUsd(livePnl)} tone={(livePnl ?? 0) >= 0 ? 'good' : 'bad'} />
                <Kpi label="Budget" value={formatUsd(liveProbe.budget_usd)} />
                <Kpi label="Kill Line" value={formatUsd(liveProbe.kill_line_usd)} tone="bad" />
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Current Position</div>
                  <div className="mt-1 text-sm font-medium text-zinc-100">{liveProbe.position_label}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Last Action</div>
                  <div className="mt-1 text-sm font-medium text-zinc-100">{liveProbe.last_action}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Start Equity</div>
                  <div className="mt-1 text-sm font-medium text-zinc-100">{formatUsd(liveProbe.starting_equity_usd)}</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Paper Cluster</div>
                  <h3 className="mt-1 text-sm font-medium text-zinc-100">Four config shadow runs</h3>
                </div>
                <span className="text-[11px] text-zinc-500">net-R snapshot</span>
              </div>
              {paperChartData.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No paper configs yet.</div>
              ) : (
                <div style={{ height: Math.max(180, paperChartData.length * 36) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={paperChartData} layout="vertical" margin={{ top: 2, right: 12, bottom: 2, left: 2 }}>
                      <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.05)" />
                      <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="label" width={132} tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" />
                      <Tooltip
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                        contentStyle={{ background: '#0c0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                        formatter={(value) => [`${Number(value ?? 0).toFixed(2)} R`, 'net-R']}
                      />
                      <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={16} isAnimationActive={false}>
                        {paperChartData.map((d, i) => (
                          <Cell key={i} fill={d.value >= 0 ? GOOD : BAD} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        )}

        {liveForward?.available && paperRows.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
            <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr_0.9fr] gap-3 border-b border-white/10 px-4 py-3 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
              <div>Paper Config</div>
              <div className="text-right">Signal</div>
              <div className="text-right">Trades</div>
              <div className="text-right">Position</div>
              <div className="text-right">Net-R</div>
            </div>
            <div>
              {paperRows.map((row) => (
                <div
                  key={row.config_id}
                  className="grid grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr_0.9fr] gap-3 border-t border-white/5 px-4 py-3 text-xs"
                >
                  <div>
                    <div className="font-medium text-zinc-200">{row.config_id.replace(/_/g, ' ')}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {row.win_pct != null ? `${row.win_pct.toFixed(0)}% win` : 'No closed trades'} · {row.last_action}
                    </div>
                  </div>
                  <div className="text-right text-zinc-300">{row.last_signal}</div>
                  <div className="text-right font-mono text-zinc-400">{row.paper_trades}</div>
                  <div className="text-right">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        row.position === 'flat'
                          ? 'bg-white/5 text-zinc-300'
                          : row.position === 'long'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-rose-500/10 text-rose-300'
                      }`}
                    >
                      {row.position}
                    </span>
                  </div>
                  <div className={`text-right font-mono ${((row.net_r ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80')}`}>
                    {formatSignedR(row.net_r)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Zone 2 — KPI decision strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Configs Tried" value={s.tried?.toLocaleString() ?? '--'} />
        <Kpi label="Cleared Sample" value={s.cleared?.toLocaleString() ?? '--'} />
        <Kpi label="Proven Survivors" value={String(s.survivors)} tone={s.survivors > 0 ? 'good' : 'bad'} />
        <Kpi
          label="Best Held-out t"
          value={chartData.length ? (Math.max(...cands.map((c) => c.t_stat ?? 0))).toFixed(2) : '--'}
          tone="accent"
        />
      </div>
      {s.note && (
        <p className="text-xs text-zinc-500">
          {s.note} <span className="text-zinc-600">· {s.data_source}{s.fee_per_side != null ? ` · ${(s.fee_per_side * 100).toFixed(3)}%/side` : ''}</span>
        </p>
      )}

      {/* Zone 3 — hero viz: strategy funnel + top candidates */}
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        {/* Funnel — the decreasing-stage pipeline (Tried → Survivors) */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-zinc-200">Strategy Funnel</h2>
            <span className="text-[11px] text-zinc-500">how many survive each gate</span>
          </div>
          {funnel.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No funnel data yet.</div>
          ) : (
            <div className="space-y-2.5">
              {funnel.map((f, i) => {
                const pct = funnelMax > 0 ? Math.max((f.value / funnelMax) * 100, 1.5) : 0;
                const isSurvivors = i === funnel.length - 1;
                const isZero = f.value === 0;
                const barColor = isSurvivors
                  ? isZero
                    ? 'from-rose-500/40 to-rose-500/10'
                    : 'from-emerald-500/60 to-emerald-500/15'
                  : 'from-cyan-500/40 to-cyan-500/5';
                const dropped = i > 0 ? funnel[i - 1].value - f.value : null;
                return (
                  <div key={f.stage}>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-zinc-300">{f.stage}</span>
                      <span className="flex items-baseline gap-2">
                        {dropped != null && dropped > 0 && (
                          <span className="text-[10px] tabular-nums text-zinc-600">−{dropped.toLocaleString()}</span>
                        )}
                        <span
                          className={`text-sm font-semibold tabular-nums ${
                            isSurvivors ? (isZero ? 'text-rose-400' : 'text-emerald-400') : 'text-zinc-100'
                          }`}
                        >
                          {f.value.toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <div className="h-7 overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/5">
                      <div
                        className={`flex h-full items-center rounded-lg bg-gradient-to-r ${barColor} px-2`}
                        style={{ width: `${pct}%` }}
                      >
                        {isZero && isSurvivors && (
                          <span className="whitespace-nowrap text-[10px] font-semibold text-rose-200">0 proven</span>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-zinc-600">{f.hint}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top candidates by held-out R — only the best 8, colored by verdict */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-zinc-200">Top Candidates by Held-out R</h2>
            <span className="text-[11px] text-zinc-500">best 8 · how close they got</span>
          </div>
          {chartData.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No candidates yet.</div>
          ) : (
            <>
              <div style={{ height: Math.max(200, chartData.length * 30) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 8 }}>
                    <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.05)" />
                    <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={160}
                      tick={{ fill: '#a1a1aa', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      contentStyle={{ background: '#0c0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                      formatter={(value, _name, payload: { payload?: { t?: number; trades?: number | null } }) => [
                        `${Number(value ?? 0).toFixed(1)} R · t=${payload?.payload?.t?.toFixed?.(2) ?? '--'} · ${payload?.payload?.trades ?? '--'} trades`,
                        'held-out',
                      ]}
                    />
                    <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={16} isAnimationActive={false}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={verdictFill[d.verdict]} fillOpacity={0.9} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-white/5 pt-3 text-[10px] text-zinc-500">
                <LegendDot color={GOOD} label="Proven survivor" />
                <LegendDot color={ACCENT} label="Cleared discovery (t > 1.96)" />
                <LegendDot color="#52525b" label="Killed by multiple-testing" />
                <LegendDot color={BAD} label="Negative held-out R" />
                {bonfBar != null && (
                  <span className="ml-auto text-zinc-600">promotion bar: t &gt; {bonfBar.toFixed(2)}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Zone 4 — evidence: red-team findings (clean structured bullets, hidden if empty) */}
      {(() => {
        const findings = (data.structural_findings ?? [])
          .map((f) => String(f).trim())
          .filter(Boolean);
        if (findings.length === 0 && !data.redteam_summary) return null;
        return (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <div className="mb-3 flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-medium text-zinc-200">Red-Team Findings</h2>
              {data.iteration_focus && (
                <span className="text-[11px] text-cyan-300/80">· focus: {data.iteration_focus.slice(0, 90)}</span>
              )}
            </div>
            <ul className="space-y-2">
              {findings.slice(0, 5).map((f, i) => {
                // Many findings are "HEADER: detail" — split into a labeled bullet.
                const m = f.match(/^([A-Z][A-Z0-9 _-]{3,40}):\s*(.+)$/);
                return (
                  <li key={i} className="flex gap-2.5 text-xs leading-relaxed">
                    <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70" />
                    <span className="text-zinc-400">
                      {m ? (
                        <>
                          <span className="font-semibold text-zinc-200">{m[1].replace(/_/g, ' ')}</span>
                          {' — '}
                          {m[2]}
                        </>
                      ) : (
                        f
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })()}

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-200">All Candidates</h2>
          <p className="text-[11px] text-zinc-500">Real only if it clears held-out + funding + multiple-testing (Bonferroni). Most get killed — that's the point.</p>
        </div>
        {cands.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-sm text-zinc-500">No candidates recorded.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-zinc-500">Strategy</TableHead>
                <TableHead className="text-zinc-500">Asset</TableHead>
                <TableHead className="text-zinc-500">Variant</TableHead>
                <TableHead className="text-right text-zinc-500">Held-out R</TableHead>
                <TableHead className="text-right text-zinc-500">Trades</TableHead>
                <TableHead className="text-right text-zinc-500">t</TableHead>
                <TableHead className="text-right text-zinc-500">Verdict</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cands.map((c, i) => (
                <TableRow key={i} className="border-white/5">
                  <TableCell className="text-xs text-zinc-300">{c.strategy.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-xs font-medium text-zinc-200">{c.asset.replace('USDT', '')} <span className="text-zinc-600">{c.timeframe}</span></TableCell>
                  <TableCell className="text-xs text-zinc-500">{c.variant}</TableCell>
                  <TableCell className={`text-right font-mono text-xs ${(c.heldout_net_r ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                    {c.heldout_net_r != null ? c.heldout_net_r.toFixed(1) : '--'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{c.heldout_trades ?? '--'}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{c.t_stat != null ? c.t_stat.toFixed(2) : '--'}</TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        c.real ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/10 text-rose-300/80'
                      }`}
                      title={c.reason}
                    >
                      {c.real ? 'REAL' : 'KILLED'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
