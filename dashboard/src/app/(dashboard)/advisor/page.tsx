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
  CartesianGrid,
  LineChart,
  Line,
  ReferenceLine,
} from 'recharts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Personal Investing Advisor dashboard (B 2026-06-04, rebuilt per dashboard-design skill).
// 4-zone IA: header · KPI strip · hero viz · evidence. Dark blue-gray, one accent, semantic colors.
// Advisor (not auto-trader): paper track-record gates trusting it with real capital.

const ACCENT = '#22d3ee';

interface Summary {
  status: string; proven: boolean; picks_sent: number; resolved: number; wins: number;
  hit_rate: number | null; hypothetical_pnl: number; watchlist_count: number; signals_total: number; note: string | null;
}
interface Pick {
  id: number; symbol: string; sent_at: string; conviction: number; direction: string;
  entry_price: number | null; target_price: number | null; stop_loss: number | null;
  position_size_usd: number | null; result: string | null; return_30d: number | null; hypothetical_pnl: number | null;
}
interface Data {
  available: boolean; reason?: string; summary?: Summary; picks?: Pick[];
  pnl_series?: { t: number; cum: number; symbol: string }[];
  calibration?: { bucket: string; n: number; hit_rate: number | null }[];
  source_scorecard?: { signal_type: string; n: number }[];
}

const money = (v: number | null) => (v == null ? '--' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`);
const pct = (v: number | null) => (v == null ? '--' : `${(v * 100).toFixed(0)}%`);

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'accent' }) {
  const color = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : tone === 'accent' ? 'text-cyan-300' : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export default function AdvisorPage() {
  const [data, setData] = useState<Data | null>(null);
  const fetchData = useCallback(() => {
    fetch('/api/advisor-performance').then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (!data) return <div className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />;
  if (!data.available)
    return <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm text-zinc-400">Advisor data unavailable: {data.reason}</div>;

  const s = data.summary!;
  const picks = data.picks ?? [];
  const series = data.pnl_series ?? [];
  // Show DISTINCT symbols, not many picks of one ticker. One symbol's repeats (e.g. 13x 'MA' all
  // tied at top conviction) were filling the entire chart + table. Keep highest-conviction per symbol. (2026-06-06)
  const distinctPicks = Object.values(
    picks.reduce((acc: Record<string, Pick>, p) => {
      if (!acc[p.symbol] || p.conviction > acc[p.symbol].conviction) acc[p.symbol] = p;
      return acc;
    }, {}),
  );
  const convData = [...distinctPicks]
    .sort((a, b) => b.conviction - a.conviction)
    .slice(0, 12)
    .map((p) => ({ label: p.symbol, value: Math.round(p.conviction * 100), dir: p.direction }));

  return (
    <div className="space-y-5">
      {/* Zone 1 — header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Personal Investing Advisor</h1>
          <p className="mt-1 text-xs text-zinc-500">Advisor, not auto-trader — surfaces opportunities, you decide. Paper track-record gates real capital.</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wider ${s.proven ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
          {s.status}
        </span>
      </div>

      {/* Zone 2 — KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Picks Sent" value={String(s.picks_sent)} tone="accent" />
        <Kpi label="Hit-rate" value={s.hit_rate == null ? '--' : pct(s.hit_rate)} tone={s.hit_rate != null && s.hit_rate >= 0.5 ? 'good' : undefined} />
        <Kpi label="Hypothetical P&L" value={money(s.hypothetical_pnl)} tone={s.hypothetical_pnl >= 0 ? 'good' : 'bad'} />
        <Kpi label="Watchlist" value={`${s.watchlist_count}`} />
      </div>
      <p className="text-xs text-zinc-500">{s.note ?? `${s.signals_total} signals scanned · ${s.resolved} picks resolved · outcomes scored at +30d`}</p>

      {/* Zone 3 — hero: P&L track-record once resolved, else today's picks by conviction */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-200">{series.length >= 2 ? 'Pick P&L Track-Record' : 'Current Picks by Conviction'}</h2>
          <span className="text-[11px] text-zinc-500">{series.length >= 2 ? 'cumulative hypothetical, resolved only' : 'conviction % · bar ≥ entry bar to act'}</span>
        </div>
        {series.length >= 2 ? (
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 20, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} scale="time" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v}`} width={44} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                <Tooltip contentStyle={{ background: '#0c0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="cum" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : convData.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No picks yet — fires as conviction clears the bar.</div>
        ) : (
          <div style={{ height: Math.max(200, convData.length * 30) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={convData} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 8 }}>
                <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" domain={[0, 100]} tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
                <YAxis type="category" dataKey="label" width={64} tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  contentStyle={{ background: '#0c0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                  formatter={(value) => [`${Number(value ?? 0)}% conviction`, '']}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={16} isAnimationActive={false}>
                  {convData.map((d, i) => (
                    <Cell key={i} fill={d.dir === 'bullish' ? '#34d399' : '#fb7185'} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Zone 4 — picks table */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-200">Picks</h2>
          <p className="text-[11px] text-zinc-500">Every pick the advisor has sent + its outcome. Advisory — you decide.</p>
        </div>
        {picks.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-sm text-zinc-500">No picks yet. Fires when conviction clears the bar.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-zinc-500">Symbol</TableHead>
                <TableHead className="text-zinc-500">Date</TableHead>
                <TableHead className="text-right text-zinc-500">Conviction</TableHead>
                <TableHead className="text-right text-zinc-500">Dir</TableHead>
                <TableHead className="text-right text-zinc-500">Entry</TableHead>
                <TableHead className="text-right text-zinc-500">Result</TableHead>
                <TableHead className="text-right text-zinc-500">Hypo P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...distinctPicks].sort((a, b) => b.conviction - a.conviction).slice(0, 30).map((p) => (
                <TableRow key={p.id} className="border-white/5">
                  <TableCell className="text-xs font-medium text-zinc-200">{p.symbol}</TableCell>
                  <TableCell className="text-xs text-zinc-500">{p.sent_at?.slice(0, 10)}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-cyan-300/90">{p.conviction?.toFixed(2)}</TableCell>
                  <TableCell className={`text-right text-xs uppercase ${p.direction === 'bullish' ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>{p.direction?.slice(0, 4)}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-300">{p.entry_price != null ? `$${p.entry_price}` : '--'}</TableCell>
                  <TableCell className="text-right text-xs text-zinc-400">{p.result ?? 'pending'}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-300">{money(p.hypothetical_pnl)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Zone 4b — calibration + signal sources */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <h2 className="mb-1 text-sm font-medium text-zinc-200">Accuracy by Conviction</h2>
          <p className="mb-2 text-[11px] text-zinc-500">Do higher-conviction picks win more? (resolved)</p>
          <Table>
            <TableHeader><TableRow className="border-white/10 hover:bg-transparent"><TableHead className="text-zinc-500">Conviction</TableHead><TableHead className="text-right text-zinc-500">N</TableHead><TableHead className="text-right text-zinc-500">Hit-rate</TableHead></TableRow></TableHeader>
            <TableBody>
              {(data.calibration ?? []).map((c) => (
                <TableRow key={c.bucket} className="border-white/5">
                  <TableCell className="font-mono text-xs text-zinc-300">{c.bucket}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{c.n}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{c.hit_rate == null ? '--' : pct(c.hit_rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <h2 className="mb-1 text-sm font-medium text-zinc-200">Signal Sources</h2>
          <p className="mb-2 text-[11px] text-zinc-500">What's feeding the advisor (hit-rate per source fills as picks resolve)</p>
          <Table>
            <TableHeader><TableRow className="border-white/10 hover:bg-transparent"><TableHead className="text-zinc-500">Source</TableHead><TableHead className="text-right text-zinc-500">Signals</TableHead></TableRow></TableHeader>
            <TableBody>
              {(data.source_scorecard ?? []).map((r) => (
                <TableRow key={r.signal_type} className="border-white/5">
                  <TableCell className="text-xs text-zinc-300">{r.signal_type}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-zinc-400">{r.n}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
