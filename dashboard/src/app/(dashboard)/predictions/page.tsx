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
import { IconRefresh, IconAlertTriangle } from '@tabler/icons-react';
import { StrategyLiveView } from '@/components/strategy/strategy-live-view';
import { StrategyPnlTimeseries } from '@/components/strategy/strategy-pnl-timeseries';
import { StrategyPipeline } from '@/components/strategy/strategy-pipeline';

// Prediction-markets dashboard (B 2026-06-05, rebuilt to match the /futures
// design system: 4-zone IA, KPI strip, real chart visualizations, dark blue-gray
// discipline, ONE cyan accent, semantic red/green only). LIVE (real money) and
// PAPER (simulated) stay HARD-separated — never combined. All figures real from
// /api/predictions; no fabrication.

const ACCENT = '#22d3ee';
const GOOD = '#34d399';
const BAD = '#fb7185';

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
  live_pnl_displayed: number;
  live_wins_displayed: number;
  live_losses_displayed: number;
  live_excluded: boolean;
  last_trade_at: string | null;
  platform: string | null;
}

interface RecentTrade {
  id: number;
  lane: string;
  platform: string;
  event_name: string | null;
  direction: string | null;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  pnl: number | null;
  signal_source: string | null;
  paper_mode: boolean;
  created_at: string | null;
  closed_at: string | null;
  notes: string | null;
}

interface PredictionData {
  lanes: LaneSummary[];
  totals: {
    trade_count: number;
    wins: number;
    losses: number;
    total_pnl: number;
    live_pnl: number;
    paper_pnl: number;
    live_wins: number;
    live_losses: number;
    live_lanes: number;
    live_pnl_displayed: number;
    live_wins_displayed: number;
    live_losses_displayed: number;
    live_lanes_displayed: number;
    live_pnl_excluded: number;
  };
  recent_trades: RecentTrade[];
  error?: string;
}

const LANE_LABELS: Record<string, string> = {
  btc: 'Sidewinder (BTC)',
  eth: 'ETH',
  glint: 'Glint',
  sol: 'SOL',
  weather: 'Weather',
  macro: 'Macro',
  ghost: 'Ghost Settlement',
  nighthawk: 'Nighthawk',
  clock: 'Settlement Clock',
};

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  return `${sign}$${pnl.toFixed(2)}`;
}

function formatWinRate(wins: number, losses: number): string {
  const total = wins + losses;
  if (total === 0) return '--';
  return `${((wins / total) * 100).toFixed(0)}%`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '--';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'accent';
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-rose-400'
        : tone === 'accent'
          ? 'text-cyan-300'
          : 'text-zinc-100';
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.015] px-4 py-3 ring-1 ring-white/10 shadow-lg shadow-black/30">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-zinc-600">{sub}</div>}
    </div>
  );
}

export default function PredictionsPage() {
  const [data, setData] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/predictions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(json.error || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-5 animate-pulse">
        <div className="h-7 w-56 rounded bg-white/[0.04]" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-white/[0.03]" />
          ))}
        </div>
        <div className="h-72 rounded-2xl bg-white/[0.02]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm text-zinc-400">
        <div className="mb-1 flex items-center gap-2 text-rose-400">
          <IconAlertTriangle size={16} />
          <span className="font-medium">Failed to load prediction data.</span>
        </div>
        {error && <p className="text-xs text-zinc-500">{error}</p>}
      </div>
    );
  }

  const { lanes, totals, recent_trades } = data;
  const liveLanes = lanes.filter((l) => l.has_live);
  // Lanes that are live AND not a display-excluded test run — these drive the
  // "Real Money Active" alarm so a frozen test run doesn't trip a false alarm.
  const activeLiveLanes = lanes.filter((l) => l.has_live && !l.live_excluded);
  const activeLanes = lanes.filter((l) => l.trade_count > 0);
  const inactiveLanes = lanes.filter((l) => l.trade_count === 0);
  const paperTrades = lanes.reduce((s, l) => s + (l.paper_trade_count ?? 0), 0);
  const paperWins = totals.wins - totals.live_wins;
  const paperLosses = totals.losses - totals.live_losses;
  const hasExcludedTest = liveLanes.some((l) => l.live_excluded);

  // Hero viz: per-lane displayed P&L (diverging bars), semantic red/green.
  const laneChart = [...activeLanes]
    .map((l) => {
      const headlineLive = l.has_live && !l.live_excluded;
      const pnl = headlineLive
        ? l.live_pnl_displayed
        : l.live_excluded
          ? l.paper_pnl
          : l.total_pnl;
      return {
        label: (LANE_LABELS[l.lane] || l.lane).replace(' (BTC)', ''),
        value: pnl,
        live: headlineLive,
      };
    })
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-5">
      {/* Zone 1 — header / command bar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Prediction Markets</h1>
            {activeLiveLanes.length > 0 ? (
              <span className="flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
                {activeLiveLanes.length} LIVE
              </span>
            ) : (
              <span className="rounded-full border border-zinc-500/30 bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-zinc-400">
                REAL MONEY FROZEN
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {totals.trade_count} trades across {activeLanes.length} active lane
            {activeLanes.length !== 1 ? 's' : ''}
            {totals.live_lanes_displayed > 0 && ` · ${totals.live_lanes_displayed} live with real money`}
            {liveLanes.length > activeLiveLanes.length &&
              ` · ${liveLanes.length - activeLiveLanes.length} test run excluded`}
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            fetchData();
          }}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
        >
          <IconRefresh size={14} />
          Refresh
        </button>
      </div>

      {/* Zone 2 — KPI decision strip (LIVE vs PAPER hard-separated) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Live P&L (real $)"
          value={formatPnl(totals.live_pnl_displayed)}
          sub={`${totals.live_wins_displayed}W / ${totals.live_losses_displayed}L · ${formatWinRate(totals.live_wins_displayed, totals.live_losses_displayed)}`}
          tone={totals.live_pnl_displayed >= 0 ? 'good' : 'bad'}
        />
        <Kpi
          label="Live Lanes"
          value={String(totals.live_lanes_displayed)}
          sub="real money at risk"
          tone={totals.live_lanes_displayed > 0 ? 'bad' : 'accent'}
        />
        <Kpi
          label="Paper P&L (sim)"
          value={formatPnl(totals.paper_pnl)}
          sub={`${paperWins}W / ${paperLosses}L · ${formatWinRate(paperWins, paperLosses)}`}
          tone={totals.paper_pnl >= 0 ? 'good' : 'bad'}
        />
        <Kpi label="Paper Trades" value={paperTrades.toLocaleString()} sub="test only, no money" />
      </div>

      {hasExcludedTest && Math.abs(totals.live_pnl - totals.live_pnl_displayed) > 0.005 && (
        <p className="text-xs text-zinc-500">
          Live P&L excludes a real-money <span className="font-medium text-zinc-300">test run</span> (
          {formatPnl(totals.live_pnl - totals.live_pnl_displayed)}, Sidewinder/Kalshi BTC — band edge killed
          OOS, trading frozen). Data kept intact; shown in the lane table below.
        </p>
      )}

      {/* Zone 3 — hero viz: per-lane P&L (diverging bars) */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Lane P&L</h2>
          <span className="text-[11px] text-zinc-500">displayed P&L · green = profit, red = loss</span>
        </div>
        {laneChart.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No trades recorded yet.</div>
        ) : (
          <div style={{ height: Math.max(180, laneChart.length * 34) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={laneChart} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={140}
                  tick={{ fill: '#a1a1aa', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  contentStyle={{ background: '#0c0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                  formatter={(value, _name, payload: { payload?: { live?: boolean } }) => [
                    `${formatPnl(Number(value ?? 0))} ${payload?.payload?.live ? '(live)' : '(paper)'}`,
                    'P&L',
                  ]}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={16} isAnimationActive={false}>
                  {laneChart.map((d, i) => (
                    <Cell key={i} fill={d.value >= 0 ? GOOD : BAD} fillOpacity={d.live ? 0.95 : 0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Strategy pipeline + graveyard — count everything tested, show every killed edge. */}
      <StrategyPipeline />

      {/* Per-strategy LIVE view — read-only, 30s refresh. */}
      <StrategyLiveView />

      {/* Paper results over time — cumulative P&L per strategy as trades resolve. */}
      <StrategyPnlTimeseries />

      {/* 9-Lane signal grid — dense bento status strip */}
      <div className="grid grid-cols-3 gap-2 lg:grid-cols-9">
        {Object.keys(LANE_LABELS).map((key) => {
          const lane = lanes.find((l) => l.lane === key);
          const active = lane && lane.trade_count > 0;
          // A display-excluded test-run lane is treated as NON-live for the grid.
          const live = !!lane?.has_live && !lane?.live_excluded;
          const pnlVal = live
            ? (lane?.live_pnl_displayed ?? 0)
            : lane?.live_excluded
              ? (lane?.paper_pnl ?? 0)
              : (lane?.total_pnl ?? 0);
          return (
            <div
              key={key}
              className={`rounded-lg border p-2.5 transition-colors ${
                live
                  ? 'border-rose-500/30 bg-rose-500/[0.06]'
                  : active
                    ? 'border-cyan-400/20 bg-cyan-400/[0.04]'
                    : 'border-white/8 bg-white/[0.015]'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    live ? 'bg-rose-400 animate-pulse' : active ? 'bg-emerald-400' : 'bg-zinc-600'
                  }`}
                />
                <span className="truncate text-[11px] font-medium text-zinc-300">
                  {LANE_LABELS[key].replace(' (BTC)', '')}
                </span>
              </div>
              <p
                className={`mt-1 text-sm font-semibold tabular-nums ${
                  !active ? 'text-zinc-600' : pnlVal >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {active ? formatPnl(pnlVal) : '--'}
              </p>
              <p className="text-[10px] text-zinc-600">
                {active ? `${lane!.trade_count} tr · ${lane!.open_count} open` : 'idle'}
              </p>
            </div>
          );
        })}
      </div>

      {/* Real-money active warning — only for non-excluded live lanes. */}
      {activeLiveLanes.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/[0.05] p-4">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-400" />
          <div>
            <p className="text-sm font-medium text-rose-300">Real Money Active</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {activeLiveLanes.map((l) => LANE_LABELS[l.lane] || l.lane).join(', ')}{' '}
              {activeLiveLanes.length === 1 ? 'is' : 'are'} trading with real money. Live P&L:{' '}
              <span className={`font-mono font-medium ${totals.live_pnl_displayed >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {formatPnl(totals.live_pnl_displayed)}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Excluded test-run note — transparency, not hidden. */}
      {hasExcludedTest && (
        <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-zinc-500" />
          <div>
            <p className="text-sm font-medium text-zinc-200">Real-money test run (excluded from live total)</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {liveLanes
                .filter((l) => l.live_excluded)
                .map((l) => LANE_LABELS[l.lane] || l.lane)
                .join(', ')}{' '}
              was a real-money TEST run (band edge killed OOS, trading frozen). Its{' '}
              <span className="font-mono">{formatPnl(totals.live_pnl_excluded)}</span> is omitted from the
              headline live P&L above. Data is intact — full numbers are in the lane table.
            </p>
          </div>
        </div>
      )}

      {/* Zone 4 — evidence: lane status table */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-200">Lane Status</h2>
          <p className="text-[11px] text-zinc-500">Per-lane breakdown of the 9-lane prediction system</p>
        </div>
        <div className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.6fr_0.5fr_0.7fr_0.6fr_0.8fr_0.7fr] gap-2 border-b border-white/10 px-4 py-2.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          <div>Lane</div>
          <div>Mode</div>
          <div>Platform</div>
          <div className="text-right">Trades</div>
          <div className="text-right">Open</div>
          <div className="text-right">W / L</div>
          <div className="text-right">Win</div>
          <div className="text-right">P&L</div>
          <div className="text-right">Last</div>
        </div>
        <div>
          {[...activeLanes, ...inactiveLanes].map((lane) => {
            const headlineLive = lane.has_live && !lane.live_excluded;
            const rowWins = headlineLive
              ? lane.live_wins_displayed
              : lane.live_excluded
                ? lane.wins - lane.live_wins
                : lane.wins;
            const rowLosses = headlineLive
              ? lane.live_losses_displayed
              : lane.live_excluded
                ? lane.losses - lane.live_losses
                : lane.losses;
            const rowPnl = headlineLive
              ? lane.live_pnl_displayed
              : lane.live_excluded
                ? lane.paper_pnl
                : lane.total_pnl;
            const idle = lane.trade_count === 0;
            return (
              <div
                key={lane.lane}
                className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.6fr_0.5fr_0.7fr_0.6fr_0.8fr_0.7fr] items-center gap-2 border-t border-white/5 px-4 py-2.5 text-xs"
              >
                <div className="font-medium text-zinc-200">{LANE_LABELS[lane.lane] || lane.lane}</div>
                <div className="flex flex-wrap gap-1">
                  {lane.has_live && !lane.live_excluded && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">LIVE</span>
                  )}
                  {lane.live_excluded && (
                    <span
                      className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400"
                      title="Real-money test run, excluded from displayed live P&L. Data intact."
                    >
                      TEST
                    </span>
                  )}
                  {lane.has_paper && (
                    <span className="rounded bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">PAPER</span>
                  )}
                  {!lane.has_live && !lane.has_paper && <span className="text-zinc-600">--</span>}
                </div>
                <div className="text-zinc-500">{lane.platform || '--'}</div>
                <div className="text-right font-mono text-zinc-300">{lane.trade_count || '--'}</div>
                <div className="text-right font-mono">
                  {lane.open_count > 0 ? <span className="text-cyan-300">{lane.open_count}</span> : <span className="text-zinc-600">0</span>}
                </div>
                <div className="text-right font-mono">
                  {idle ? (
                    <span className="text-zinc-600">--</span>
                  ) : (
                    <>
                      <span className="text-emerald-400">{rowWins}</span>
                      <span className="text-zinc-600">/</span>
                      <span className="text-rose-400">{rowLosses}</span>
                    </>
                  )}
                </div>
                <div className="text-right font-mono text-zinc-400">{idle ? '--' : formatWinRate(rowWins, rowLosses)}</div>
                <div className="text-right">
                  {idle ? (
                    <span className="text-zinc-600">--</span>
                  ) : (
                    <span className={`font-mono font-medium ${rowPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatPnl(rowPnl)}
                      <span className="ml-1 text-[9px] uppercase text-zinc-600">{headlineLive ? 'live' : 'paper'}</span>
                    </span>
                  )}
                </div>
                <div className="text-right text-zinc-500">{timeAgo(lane.last_trade_at)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent trades */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-200">Recent Trades</h2>
          <p className="text-[11px] text-zinc-500">Last 20 trades across all lanes</p>
        </div>
        <div className="grid grid-cols-[1.2fr_0.6fr_0.6fr_0.7fr_0.7fr_0.5fr_0.7fr_0.7fr_1.4fr] gap-2 border-b border-white/10 px-4 py-2.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          <div>Lane</div>
          <div>Dir</div>
          <div>Mode</div>
          <div className="text-right">Entry</div>
          <div className="text-right">Exit</div>
          <div className="text-right">Qty</div>
          <div className="text-right">P&L</div>
          <div className="text-right">Time</div>
          <div>Notes</div>
        </div>
        {recent_trades.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-sm text-zinc-500">No trades recorded yet.</div>
        ) : (
          <div>
            {recent_trades.map((trade) => (
              <div
                key={trade.id}
                className="grid grid-cols-[1.2fr_0.6fr_0.6fr_0.7fr_0.7fr_0.5fr_0.7fr_0.7fr_1.4fr] items-center gap-2 border-t border-white/5 px-4 py-2.5 text-xs"
              >
                <div className="font-medium text-zinc-200">{LANE_LABELS[trade.lane] || trade.lane}</div>
                <div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      trade.direction === 'yes' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-zinc-300'
                    }`}
                  >
                    {trade.direction?.toUpperCase() || '--'}
                  </span>
                </div>
                <div>
                  {trade.paper_mode ? (
                    <span className="text-cyan-300/80">Paper</span>
                  ) : (
                    <span className="font-medium text-rose-400">LIVE</span>
                  )}
                </div>
                <div className="text-right font-mono text-zinc-400">
                  {trade.entry_price != null ? `$${trade.entry_price.toFixed(2)}` : '--'}
                </div>
                <div className="text-right font-mono text-zinc-400">
                  {trade.exit_price != null ? `$${trade.exit_price.toFixed(2)}` : trade.closed_at ? '--' : 'OPEN'}
                </div>
                <div className="text-right font-mono text-zinc-400">{trade.quantity ?? '--'}</div>
                <div className="text-right">
                  {trade.pnl != null ? (
                    <span className={`font-mono font-medium ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatPnl(trade.pnl)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">--</span>
                  )}
                </div>
                <div className="text-right text-zinc-500">{timeAgo(trade.created_at)}</div>
                <div className="truncate text-zinc-500" title={trade.notes || undefined}>
                  {trade.notes || '--'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
