'use client';

import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AXIS_STYLE, GRID_STYLE } from '@/components/charts/chart-theme';
import { TAG_COLOR } from './strategy-performance-chart';

// Paper-results-over-time (Atlas redesign §5): cumulative P&L per strategy/lane
// across time. Live = solid, paper = dashed, real-money test run = dimmed.

interface Pt {
  t: number;
  cum: number;
}
interface Series {
  key: string;
  lane: string;
  label: string;
  paper_mode: number;
  is_live: boolean;
  tag: keyof typeof TAG_COLOR;
  excluded: boolean;
  net: number;
  trade_count: number;
  points: Pt[];
}

const fmtDate = (t: number) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtMoney = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

function TsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const rows = [...payload]
    .filter((p) => typeof p.value === 'number')
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="rounded-md border border-border/60 bg-background/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-foreground">
        {typeof label === 'number' ? new Date(label).toLocaleString() : ''}
      </div>
      {rows.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5" style={{ color: p.color }}>
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            {p.name}
          </span>
          <span className="font-mono text-foreground">{fmtMoney(p.value ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}

export function StrategyPnlTimeseries() {
  const [series, setSeries] = useState<Series[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/strategy-timeseries')
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          if (j.error) setErr(j.error);
          else setSeries(j.series ?? []);
        })
        .catch((e) => alive && setErr(String(e)));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (err) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          Couldn&apos;t load P&amp;L over time: {err}
        </CardContent>
      </Card>
    );
  }
  if (!series) {
    return <div className="h-80 animate-pulse rounded-xl bg-muted/30" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paper Results Over Time</CardTitle>
        <CardDescription>
          Cumulative P&amp;L per strategy as trades resolve. Solid = live (real money),
          dashed = paper. The real-money Sidewinder test run is dimmed (excluded from the
          live total, kept for the record).
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <div id="pnl-over-time" className="w-full" style={{ height: 340, minHeight: 340, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height={340} minHeight={340}>
            <LineChart margin={{ top: 10, right: 20, bottom: 8, left: 8 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis
                type="number"
                dataKey="t"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={fmtDate}
                {...AXIS_STYLE}
              />
              <YAxis
                tickFormatter={(v: number) => `$${v}`}
                {...AXIS_STYLE}
                width={48}
              />
              <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="4 4" strokeWidth={1} />
              <Tooltip content={<TsTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value: string) => value}
              />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  data={s.points}
                  dataKey="cum"
                  name={s.label}
                  stroke={TAG_COLOR[s.tag]}
                  strokeWidth={s.is_live && !s.excluded ? 2.5 : 1.5}
                  strokeDasharray={s.is_live ? undefined : '5 4'}
                  strokeOpacity={s.excluded ? 0.4 : 1}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
