'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IconAlertTriangle, IconEye, IconEyeOff, IconLayoutGrid } from '@tabler/icons-react';
import {
  StrategyPerformanceChart,
  TAG_COLOR,
  TAG_LABEL,
  stratKey,
  type PerfData,
  type Strategy,
} from './strategy-performance-chart';

// ─────────────────────────────────────────────────────────────────────────────
// LIVE per-strategy view (predictions route).
// Shows EVERY strategy/lane separately, live, with: paper P&L, win-rate, edge,
// # trades, and a status tag (paper-live / live / killed / backtest-only /
// test-excluded). Each row has a SHOW/HIDE toggle that controls whether the
// strategy is plotted on the edge-vs-pass-bar chart below.
//
// IMPORTANT: the toggles are a VIEW/DISPLAY filter only. They do NOT enable or
// disable live trading — that is a gated bot control and out of scope here.
//
// Auto-refreshes every 30s (paper lanes move tick-to-tick). Read-only: pulls
// /api/strategy-performance (prediction_trades.db + capital-ledger.json + TALLY).
// ─────────────────────────────────────────────────────────────────────────────

function pct(n: number | null): string {
  return n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}
function money(n: number | null): string {
  if (n == null) return 'n/a';
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}
function edgeStr(s: Strategy): string {
  return s.edge != null ? `${s.edge >= 0 ? '+' : ''}${(s.edge * 100).toFixed(1)} pts` : 'n/a';
}

export function StrategyLiveView() {
  const [data, setData] = useState<PerfData | null>(null);
  const [failed, setFailed] = useState(false);
  // Visibility map keyed by lane::paper_mode. Undefined = visible (default on).
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/strategy-performance');
      const j = (await r.json()) as PerfData;
      if (j.error) setFailed(true);
      else {
        setData(j);
        setFailed(false);
      }
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000); // live refresh, like the other panels
    return () => clearInterval(id);
  }, [load]);

  const isVisible = useCallback(
    (s: Strategy) => !hidden.has(stratKey(s)),
    [hidden],
  );

  const toggle = useCallback((s: Strategy) => {
    setHidden((prev) => {
      const next = new Set(prev);
      const k = stratKey(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  // Sort: most trades first (biggest signals on top), but keep test-excluded
  // and killed grouped at the bottom so the live/paper-live lanes read first.
  const rows = useMemo(() => {
    if (!data) return [];
    const rank = (s: Strategy) =>
      s.tag === 'test-excluded' ? 2 : s.tag === 'killed' ? 1 : 0;
    return [...data.strategies].sort(
      (a, b) => rank(a) - rank(b) || b.trade_count - a.trade_count,
    );
  }, [data]);

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
    return <div className="h-96 animate-pulse rounded-xl bg-muted/30" />;
  }

  const visibleCount = rows.filter(isVisible).length;

  return (
    <div className="space-y-4">
      {/* Per-strategy live table with show/hide toggles */}
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconLayoutGrid size={16} className="text-primary" />
                Per-Strategy Live Performance
              </CardTitle>
              <CardDescription>
                Every strategy/lane shown separately, live. Each row has a view
                toggle — it shows/hides the strategy on the chart below.{' '}
                <span className="font-medium text-foreground">
                  Toggles are display-only and do NOT enable/disable live trading.
                </span>
              </CardDescription>
            </div>
            <span className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              live · {visibleCount}/{rows.length} shown
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] text-center">View</TableHead>
                <TableHead>Strategy / Lane</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Mode</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">W / L</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">Breakeven</TableHead>
                <TableHead className="text-right">Edge</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const shown = isVisible(s);
                return (
                  <TableRow
                    key={stratKey(s)}
                    className={shown ? undefined : 'opacity-45'}
                  >
                    <TableCell className="text-center">
                      <Switch
                        size="sm"
                        checked={shown}
                        onCheckedChange={() => toggle(s)}
                        aria-label={`Show ${s.label} on chart`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: TAG_COLOR[s.tag] }}
                        />
                        <span>{s.label}</span>
                        {shown ? (
                          <IconEye size={13} className="text-muted-foreground/50" />
                        ) : (
                          <IconEyeOff size={13} className="text-muted-foreground/50" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        style={{ backgroundColor: TAG_COLOR[s.tag], color: 'white' }}
                        className="text-[10px]"
                        title={s.excluded_reason ?? undefined}
                      >
                        {TAG_LABEL[s.tag]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {s.is_live ? (
                        <span className="font-medium text-destructive">REAL $</span>
                      ) : (
                        <span className="text-muted-foreground">paper</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {s.trade_count}
                      {s.open_count > 0 && (
                        <span className="ml-1 text-[10px] text-primary">
                          ({s.open_count} open)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <span className="text-success">{s.wins}</span>
                      {' / '}
                      <span className="text-destructive">{s.losses}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {pct(s.win_rate)}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-xs text-muted-foreground"
                      title="Breakeven = avg price paid; win-rate must beat this (plus ~2pp fee) to actually profit"
                    >
                      {pct(s.breakeven)}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right font-mono text-xs ' +
                        (s.edge == null
                          ? ''
                          : s.edge > 0
                            ? 'text-success'
                            : 'text-destructive')
                      }
                    >
                      {edgeStr(s)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end">
                        <span
                          className={
                            'font-mono text-xs font-medium ' +
                            (s.net_pnl >= 0 ? 'text-success' : 'text-destructive')
                          }
                        >
                          {money(s.net_pnl)}
                        </span>
                        {s.excluded && (
                          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                            {s.excluded_label ?? 'excluded'}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* The chart, driven by the toggles above. */}
      <StrategyPerformanceChart data={data} isVisible={isVisible} />
    </div>
  );
}
