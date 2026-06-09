'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Cell,
  Tooltip,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { AXIS_STYLE, GRID_STYLE } from '@/components/charts/chart-theme';
import { IconAlertTriangle, IconTarget } from '@tabler/icons-react';

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE B — strategy-performance scatter.
// X = trade count (sample size, log-ish via count). Y = EDGE METRIC
// (realized win-rate − breakeven price). A ReferenceLine at y=0 is the funnel
// pass bar (slip+fee-adjusted net edge > 0). Above = candidate edge; below =
// not there. Every value comes from /api/strategy-performance (real DB + ledger).
// ─────────────────────────────────────────────────────────────────────────────

interface Backtest {
  verdict: string | null;
  wfe: number | null;
  dsr: number | null;
  oos_winrate: number | null;
  sample_size: number | null;
  ledger_excerpt: string | null;
}
export type StrategyTag =
  | 'paper-live'
  | 'live'
  | 'killed'
  | 'backtest-only'
  | 'test-excluded';
export interface Strategy {
  lane: string;
  paper_mode: number;
  label: string;
  is_live: boolean;
  tag: StrategyTag;
  excluded: boolean;
  excluded_label: string | null;
  excluded_reason: string | null;
  trade_count: number;
  resolved: number;
  open_count: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  breakeven: number | null;
  edge: number | null;
  net_pnl: number;
  pnl_per_trade: number | null;
  last_trade_at: string | null;
  first_trade_at: string | null;
  backtest: Backtest;
}
export interface PerfData {
  strategies: Strategy[];
  capital: {
    account?: { total_value: number; net_pnl: number; deposit: number; updated_at: string };
    strategies?: Array<{
      strategy_id: string;
      display_name: string;
      realized_pnl: number;
      gross_pnl: number;
      fee_drag: number;
      current_value: number;
      wins: number;
      losses: number;
    }>;
  } | null;
  hunt_tally: { tried: number | null; survivors: number | null; summary: string | null };
  threshold: { edge: number; label: string };
  data_availability: { missing: string[] };
  error?: string;
}

export const TAG_COLOR: Record<StrategyTag, string> = {
  live: '#EF4444', // red — real money
  'paper-live': '#D4A017', // gold — paper running
  'backtest-only': '#2563EB', // blue
  killed: '#6B7280', // grey — killed
  'test-excluded': '#9CA3AF', // light grey — real-$ test run, excluded from live total
};
export const TAG_LABEL: Record<StrategyTag, string> = {
  live: 'LIVE (real $)',
  'paper-live': 'paper-live',
  'backtest-only': 'backtest-only',
  killed: 'killed',
  'test-excluded': 'test run (excluded)',
};

/** Stable identity for a strategy row (lane + paper_mode). */
export function stratKey(s: Pick<Strategy, 'lane' | 'paper_mode'>): string {
  return `${s.lane}::${s.paper_mode}`;
}

function pct(n: number | null): string {
  return n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}
function signed(n: number | null, dp = 2): string {
  if (n == null) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
}
function money(n: number | null): string {
  if (n == null) return 'n/a';
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

interface Point {
  x: number; // trade count
  y: number; // edge (percentage points)
  z: number; // constant — drives ZAxis symbol size (recharts v3 needs it)
  s: Strategy;
}

interface ChartProps {
  /** If provided, the chart uses this data instead of self-fetching (lets a
   *  parent own the data + the show/hide toggles). */
  data?: PerfData | null;
  /** Returns true if a strategy should be plotted (driven by the toggles). When
   *  omitted, every strategy is shown (legacy behavior). */
  isVisible?: (s: Strategy) => boolean;
  /** Hide the reconciled real-broker note (shown by the parent view instead). */
  hideBrokerNote?: boolean;
}

export function StrategyPerformanceChart({
  data: dataProp,
  isVisible,
  hideBrokerNote,
}: ChartProps = {}) {
  const controlled = dataProp !== undefined;
  const [selfData, setSelfData] = useState<PerfData | null>(null);
  const [failed, setFailed] = useState(false);
  const [drill, setDrill] = useState<Strategy | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/strategy-performance');
      const j = (await r.json()) as PerfData;
      if (j.error) {
        setFailed(true);
      } else {
        setSelfData(j);
        setFailed(false);
      }
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (controlled) return; // parent owns the data + refresh
    load();
    const id = setInterval(load, 30000); // real-time refresh for paper lanes
    return () => clearInterval(id);
  }, [load, controlled]);

  const data = controlled ? dataProp : selfData;

  if (failed) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <IconAlertTriangle size={16} /> Strategy performance source unavailable (n/a).
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return <div className="h-80 animate-pulse rounded-xl bg-muted/30" />;
  }

  // Only plot strategies with a derivable edge (need resolved trades + entry
  // price) AND that the show/hide toggles currently have visible.
  const points: Point[] = data.strategies
    .filter((s) => s.edge != null && s.trade_count > 0)
    .filter((s) => (isVisible ? isVisible(s) : true))
    .map((s) => ({ x: s.trade_count, y: (s.edge as number) * 100, z: 1, s }));

  const noEdge = data.strategies.filter((s) => s.edge == null);

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconTarget size={16} className="text-primary" />
                Strategy Edge vs Funnel Pass Bar
              </CardTitle>
              <CardDescription>
                Edge = realized win-rate − breakeven (avg entry price). Each point is a
                strategy/lane. The line at 0 is the pass bar.
              </CardDescription>
            </div>
            {data.hunt_tally.tried != null && (
              <Badge variant="secondary" className="text-[11px]">
                hunt: {data.hunt_tally.tried} tried · {data.hunt_tally.survivors ?? 'n/a'} survivors
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {/* Threshold caption */}
          <p className="mb-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Threshold (y=0):</span>{' '}
            {data.threshold.label}. Above the line = positive{' '}
            <span className="font-medium text-foreground">naive/paper</span> edge — that is
            NOT &quot;proven&quot;. Red line = naive breakeven (edge 0); GOLD line = after-fee
            NET bar (~+2pp) — you must clear GOLD to actually make money. ✕ = funnel-rejected ·
            shaded = too few trades to claim. Nothing is proven until the funnel passes it.
          </p>

          <div className="w-full" style={{ height: 320, minHeight: 320, flexShrink: 0 }}>
            <ResponsiveContainer width="100%" height={320} minHeight={320}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 28, left: 8 }}>
                <CartesianGrid {...GRID_STYLE} />
                {/* Low-power zone: <30 trades = insufficient sample to claim an edge
                    (the funnel's <30 OOS guard). Anything here is provisional, not a claim. */}
                <ReferenceArea
                  x1={0}
                  x2={30}
                  fill="#ffffff"
                  fillOpacity={0.04}
                  stroke="none"
                  ifOverflow="extendDomain"
                  label={{
                    value: 'low power (<30)',
                    position: 'insideTopLeft',
                    fontSize: 9,
                    fill: 'hsl(var(--muted-foreground))',
                  }}
                />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Trades"
                  {...AXIS_STYLE}
                  label={{
                    value: 'Sample size (trades)',
                    position: 'insideBottom',
                    offset: -16,
                    fontSize: 11,
                    fill: 'hsl(var(--muted-foreground))',
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Edge (pp)"
                  {...AXIS_STYLE}
                  tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
                  label={{
                    value: 'Edge (pts)',
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 11,
                    fill: 'hsl(var(--muted-foreground))',
                  }}
                />
                <ZAxis range={[80, 80]} />
                {/* THRESHOLD LINE — funnel pass bar */}
                <ReferenceLine
                  y={0}
                  stroke="#EF4444"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{
                    value: 'naive breakeven (edge=0)',
                    position: 'insideTopRight',
                    fontSize: 10,
                    fill: '#EF4444',
                  }}
                />
                {/* AFTER-FEE NET BAR — the real bar (Harvester fee-math): edge must clear
                    ~+2pp to beat the Kalshi fee. Below gold = positive but fee-dead. */}
                <ReferenceLine
                  y={2}
                  stroke="#D4A017"
                  strokeDasharray="2 3"
                  strokeWidth={1}
                  label={{
                    value: 'net bar (~+2pp after fee)',
                    position: 'insideBottomRight',
                    fontSize: 9,
                    fill: '#D4A017',
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={<EdgeTooltip />}
                />
                {/* recharts v3's default/ZAxis symbol sizing renders dots as zero-area
                    paths (d="M0,0") = invisible. Custom shape draws a real circle at the
                    computed cx/cy with per-point Cell fill. */}
                <ZAxis type="number" dataKey="z" range={[80, 80]} />
                <Scatter
                  data={points}
                  shape={(props: {
                    cx?: number;
                    cy?: number;
                    fill?: string;
                    stroke?: string;
                    strokeWidth?: number;
                    payload?: Point;
                  }) => {
                    const { cx, cy, fill, stroke, strokeWidth, payload } = props;
                    if (typeof cx !== 'number' || typeof cy !== 'number' || Number.isNaN(cx) || Number.isNaN(cy)) {
                      return <g />;
                    }
                    // Verdict now comes from a curated, CONFIRMED-only map (API extractVerdict),
                    // so the killed marker is trustworthy (only genuinely-killed strategies).
                    const verdict = payload?.s?.backtest?.verdict;
                    const liveRing = stroke && stroke !== 'transparent';
                    // Funnel-REJECTED (killed): hollow dashed ring + ✕ so a killed strategy
                    // reads as "tested & failed" even when its naive edge sits above the bar.
                    if (verdict === 'killed') {
                      return (
                        <g>
                          <circle
                            cx={cx}
                            cy={cy}
                            r={7}
                            fill="none"
                            stroke={fill}
                            strokeWidth={1.5}
                            strokeDasharray="2 2"
                          />
                          <path
                            d={`M${cx - 3},${cy - 3} L${cx + 3},${cy + 3} M${cx + 3},${cy - 3} L${cx - 3},${cy + 3}`}
                            stroke={fill}
                            strokeWidth={1}
                            strokeOpacity={0.85}
                          />
                        </g>
                      );
                    }
                    return (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={7}
                        fill={fill}
                        fillOpacity={0.95}
                        stroke={liveRing ? stroke : 'rgba(255,255,255,0.45)'}
                        strokeWidth={liveRing ? strokeWidth || 2 : 1}
                      />
                    );
                  }}
                  onClick={(p: unknown) => {
                    const pt = p as { payload?: Point };
                    if (pt?.payload?.s) setDrill(pt.payload.s);
                  }}
                >
                  {points.map((p, i) => (
                    <Cell
                      key={i}
                      fill={TAG_COLOR[p.s.tag]}
                      stroke={p.s.is_live ? '#EF4444' : 'transparent'}
                      strokeWidth={p.s.is_live ? 2 : 0}
                      cursor="pointer"
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {(['live', 'paper-live', 'backtest-only', 'killed'] as Strategy['tag'][]).map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: TAG_COLOR[t] }}
                />
                <span className="text-muted-foreground">{TAG_LABEL[t]}</span>
              </span>
            ))}
            <span className="text-muted-foreground">· click a point for backtest data</span>
          </div>

          {noEdge.length > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              Not plotted (no derivable edge — unresolved / no entry price):{' '}
              {noEdge.map((s) => s.label).join(', ')}
            </p>
          )}
          {data.data_availability.missing.length > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              Sources unavailable (n/a): {data.data_availability.missing.join(', ')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Reconciled real-broker note for the live lane */}
      {!hideBrokerNote && data.capital?.account && (
        <Card size="sm" className="border-destructive/30 bg-destructive/[0.03]">
          <CardContent className="py-3">
            <p className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-destructive">Reconciled real-broker truth</span>{' '}
              (capital-ledger.json):{' '}
              <span className="font-mono text-foreground">
                acct {money(data.capital.account.net_pnl)} net · value $
                {data.capital.account.total_value.toFixed(2)}
              </span>
              {data.capital.strategies?.map((s) => (
                <span key={s.strategy_id} className="ml-2 font-mono">
                  · {s.display_name}: realized {money(s.realized_pnl)} (gross{' '}
                  {money(s.gross_pnl)}, fees {money(s.fee_drag)})
                </span>
              ))}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Drill-in dialog — full backtest data per strategy */}
      <Dialog open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent className="max-w-lg">
          {drill && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {drill.label}
                  <Badge
                    style={{ backgroundColor: TAG_COLOR[drill.tag], color: 'white' }}
                    className="text-[10px]"
                  >
                    {TAG_LABEL[drill.tag]}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  Live/paper stats from prediction_trades.db · backtest verdict from the edge-hunt
                  ledger.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Field label="Trades" value={`${drill.trade_count} (${drill.open_count} open)`} />
                  <Field label="W / L" value={`${drill.wins}W / ${drill.losses}L`} />
                  <Field label="Win rate" value={pct(drill.win_rate)} />
                  <Field label="Breakeven (avg entry)" value={pct(drill.breakeven)} />
                  <Field
                    label="Edge (win − breakeven)"
                    value={drill.edge != null ? `${signed(drill.edge * 100, 1)} pts` : 'n/a'}
                    accent={drill.edge != null ? (drill.edge > 0 ? 'pos' : 'neg') : undefined}
                  />
                  <Field
                    label="Net P&L"
                    value={money(drill.net_pnl)}
                    accent={drill.net_pnl >= 0 ? 'pos' : 'neg'}
                  />
                  <Field label="P&L / trade" value={drill.pnl_per_trade != null ? money(drill.pnl_per_trade) : 'n/a'} />
                  <Field label="Mode" value={drill.is_live ? 'LIVE (real money)' : 'paper'} />
                </div>

                <div className="rounded-lg border bg-muted/10 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Backtest data (edge-hunt ledger)
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Field
                      label="Verdict"
                      value={drill.backtest.verdict ?? 'n/a'}
                      accent={
                        drill.backtest.verdict === 'killed'
                          ? 'neg'
                          : drill.backtest.verdict === 'survivor'
                            ? 'pos'
                            : undefined
                      }
                    />
                    <Field label="WFE" value={drill.backtest.wfe != null ? String(drill.backtest.wfe) : 'n/a'} />
                    <Field label="DSR" value={drill.backtest.dsr != null ? String(drill.backtest.dsr) : 'n/a'} />
                    <Field label="PBO" value="n/a" />
                    <Field
                      label="OOS win rate"
                      value={drill.backtest.oos_winrate != null ? `${drill.backtest.oos_winrate}%` : 'n/a'}
                    />
                    <Field
                      label="Sample (OOS)"
                      value={drill.backtest.sample_size != null ? String(drill.backtest.sample_size) : 'n/a'}
                    />
                  </div>
                  {drill.backtest.ledger_excerpt && (
                    <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">Ledger:</span>{' '}
                      {drill.backtest.ledger_excerpt}
                    </p>
                  )}
                  {!drill.backtest.verdict && !drill.backtest.ledger_excerpt && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      No backtest verdict found in the ledger for this lane (n/a).
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EdgeTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const s = payload[0].payload.s;
  return (
    <div className="rounded-lg border bg-card p-2.5 text-xs shadow-md">
      <p className="font-semibold">{s.label}</p>
      <p className="text-muted-foreground">{TAG_LABEL[s.tag]}</p>
      <div className="mt-1 space-y-0.5 font-mono">
        <p>paper/live P&L: {money(s.net_pnl)}</p>
        <p>
          win rate: {pct(s.win_rate)} ({s.wins}W/{s.losses}L)
        </p>
        <p>breakeven: {pct(s.breakeven)}</p>
        <p>
          edge: {s.edge != null ? `${signed(s.edge * 100, 1)} pts` : 'n/a'}
        </p>
        <p>backtest: {s.backtest.verdict ?? 'n/a'}</p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'pos' | 'neg';
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={
          'mt-0.5 font-mono font-medium ' +
          (accent === 'pos' ? 'text-success' : accent === 'neg' ? 'text-destructive' : '')
        }
      >
        {value}
      </p>
    </div>
  );
}
