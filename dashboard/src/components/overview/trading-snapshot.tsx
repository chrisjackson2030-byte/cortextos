'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  IconChartCandle,
  IconChartArea,
  IconTrendingUp,
  IconTrendingDown,
  IconArrowRight,
  IconShieldLock,
  IconShieldCheck,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface PredTotals {
  trade_count: number;
  wins: number;
  losses: number;
  total_pnl: number;
  live_pnl: number;
  paper_pnl: number;
  live_wins: number;
  live_losses: number;
  live_lanes: number;
  // DISPLAY-aware live totals (test runs excluded; data intact).
  live_pnl_displayed: number;
  live_wins_displayed: number;
  live_losses_displayed: number;
  live_lanes_displayed: number;
}
interface PredLane {
  lane: string;
  trade_count: number;
  open_count: number;
  has_live: boolean;
  total_pnl: number;
  live_pnl: number;
  live_pnl_displayed: number;
  live_excluded: boolean;
  live_trade_count: number;
}
interface PredData {
  lanes: PredLane[];
  totals: PredTotals;
}
interface OptAccount {
  status: string;
  equity: number;
  options_buying_power: number;
  options_level: number | null;
  updated_at: string;
}
interface OptData {
  status: 'HALTED' | 'DEGRADED' | 'LIVE' | 'UNKNOWN';
  kill_switch: { armed: boolean };
  account: OptAccount | null;
  broker: { state: string } | null;
  summary: { open_positions: number; total_signals: number; failed: number };
}

const LANE_LABELS: Record<string, string> = {
  btc: 'Sidewinder',
  eth: 'ETH',
  glint: 'Glint',
  sol: 'SOL',
  weather: 'Weather',
  macro: 'Macro',
  ghost: 'Ghost',
  nighthawk: 'Nighthawk',
  clock: 'Clock',
};

function pnl(n: number): string {
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

export function TradingSnapshot() {
  const [pred, setPred] = useState<PredData | null>(null);
  const [opt, setOpt] = useState<OptData | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [p, o] = await Promise.all([
          fetch('/api/predictions').then((r) => r.json()),
          fetch('/api/options').then((r) => r.json()),
        ]);
        if (!alive) return;
        if (!p.error) setPred(p);
        if (!o.error) setOpt(o);
      } catch {
        /* ignore — tiles fall back to skeleton/placeholder */
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const t = pred?.totals;
  // Jarvis Dashboard shows ONLY what we're actually live on (real money), and
  // EXCLUDES display-excluded test runs (e.g. the frozen Sidewinder/Kalshi BTC
  // test, ~-$21) from the headline live figures. Data stays intact on the
  // Operations → Prediction Markets per-strategy table.
  const liveLanes = (
    pred?.lanes.filter(
      (l) => l.has_live && !l.live_excluded && l.live_trade_count > 0,
    ) ?? []
  )
    .sort((a, b) => Math.abs(b.live_pnl_displayed) - Math.abs(a.live_pnl_displayed))
    .slice(0, 5);
  const liveResolved = t ? t.live_wins_displayed + t.live_losses_displayed : 0;
  const hasExcludedTest = (pred?.lanes ?? []).some((l) => l.live_excluded);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* ---- Prediction Markets ---- */}
      <div className="hud-panel rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-primary/15 p-1.5">
              <IconChartCandle size={16} className="text-primary" />
            </span>
            <h3 className="text-sm font-semibold">Prediction Markets</h3>
            {t && t.live_lanes_displayed > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive border border-destructive/20">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
                {t.live_lanes_displayed} LIVE
              </span>
            )}
          </div>
          <Link href="/predictions" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors">
            Open <IconArrowRight size={12} />
          </Link>
        </div>

        {!pred ? (
          <div className="h-28 animate-pulse rounded-lg bg-muted/20" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <Stat label="LIVE P&L (real $)" value={pnl(t!.live_pnl_displayed)} accent={t!.live_pnl_displayed >= 0 ? 'success' : 'destructive'} />
              <Stat
                label="Live Win Rate"
                value={liveResolved > 0 ? `${Math.round((t!.live_wins_displayed / liveResolved) * 100)}%` : '--'}
                sub={`${t!.live_wins_displayed}W / ${t!.live_losses_displayed}L`}
              />
            </div>
            <div className="space-y-1.5">
              {liveLanes.map((l) => (
                <div key={l.lane} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{LANE_LABELS[l.lane] ?? l.lane}</span>
                    <span className="rounded bg-destructive/15 px-1 text-[9px] font-semibold text-destructive">LIVE</span>
                    {l.open_count > 0 && (
                      <span className="text-[10px] text-primary">{l.open_count} open</span>
                    )}
                  </span>
                  <span className={cn('flex items-center gap-1 font-mono', l.live_pnl_displayed >= 0 ? 'text-success' : 'text-destructive')}>
                    {l.live_pnl_displayed > 0 ? <IconTrendingUp size={11} /> : l.live_pnl_displayed < 0 ? <IconTrendingDown size={11} /> : null}
                    {pnl(l.live_pnl_displayed)}
                  </span>
                </div>
              ))}
              {liveLanes.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">No live positions. Paper trading → Operations → Prediction Markets.</p>
              )}
              {hasExcludedTest && (
                <p className="text-[10px] text-muted-foreground/80 pt-1 border-t border-border/40">
                  Excludes a real-money test run (Sidewinder/Kalshi BTC, ~-$21 — band edge killed
                  OOS). Data intact → Operations → Prediction Markets.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---- Alpaca Options ---- */}
      <div className="hud-panel rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-primary/15 p-1.5">
              <IconChartArea size={16} className="text-primary" />
            </span>
            <h3 className="text-sm font-semibold">Alpaca Options</h3>
            {opt && (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border',
                  opt.status === 'LIVE'
                    ? 'bg-success/10 text-success border-success/20'
                    : opt.status === 'HALTED'
                      ? 'bg-destructive/10 text-destructive border-destructive/20'
                      : 'bg-warning/10 text-warning border-warning/20',
                )}
              >
                {opt.status}
              </span>
            )}
          </div>
          <Link href="/options" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors">
            Open <IconArrowRight size={12} />
          </Link>
        </div>

        {!opt ? (
          <div className="h-28 animate-pulse rounded-lg bg-muted/20" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className={cn('rounded-lg border px-2.5 py-2', opt.kill_switch.armed ? 'border-destructive/30 bg-destructive/5' : 'border-success/30 bg-success/5')}>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Kill Switch</p>
                <p className={cn('mt-0.5 flex items-center gap-1 text-sm font-bold font-mono', opt.kill_switch.armed ? 'text-destructive' : 'text-success')}>
                  {opt.kill_switch.armed ? <IconShieldLock size={13} /> : <IconShieldCheck size={13} />}
                  {opt.kill_switch.armed ? 'ARMED' : 'CLEAR'}
                </p>
              </div>
              <Stat label="Broker" value={opt.broker?.state ?? 'UNKNOWN'} accent={opt.broker?.state === 'HEALTHY' ? 'success' : opt.broker?.state === 'DEGRADED' ? 'warning' : 'destructive'} small />
              <Stat label="Open Pos" value={opt.summary.open_positions} />
            </div>
            {opt.account ? (
              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label="Equity"
                  value={`$${opt.account.equity.toLocaleString()}`}
                  accent={opt.account.equity >= 2000 ? 'success' : 'warning'}
                  small
                />
                <Stat
                  label="Options BP"
                  value={`$${opt.account.options_buying_power.toLocaleString()}`}
                  sub={opt.account.options_level != null ? `level ${opt.account.options_level}` : undefined}
                  small
                />
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/80">Account snapshot unavailable.</p>
            )}
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{opt.summary.total_signals} signals · {opt.summary.failed} failed</span>
              {opt.account && (
                <span className="text-[10px]">
                  acct {opt.account.status} · {new Date(opt.account.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  small,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: 'success' | 'destructive' | 'warning';
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-bold font-mono tabular-nums',
          small ? 'text-sm' : 'text-base',
          accent === 'success' && 'text-success',
          accent === 'destructive' && 'text-destructive',
          accent === 'warning' && 'text-warning',
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
