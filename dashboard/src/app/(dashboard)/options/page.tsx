'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  IconRefresh,
  IconAlertTriangle,
  IconShieldLock,
  IconShieldCheck,
  IconActivity,
  IconPlugConnected,
  IconCircleDot,
} from '@tabler/icons-react';

interface Signal {
  intent_id: string;
  state: string;
  ticker: string | null;
  action: string | null;
  right: string | null;
  strike: string | null;
  expiry: string | null;
  price: string | null;
  contracts: number | null;
  raw_text: string | null;
  broker_order_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface Position {
  symbol: string;
  qty: number;
  intent_id: string;
  confirmation_state: string;
  entered_at: string;
}

interface Halt {
  halt_id: string;
  source_module: string;
  reason_code: string;
  reason_text: string;
  triggered_at: string;
}

interface OptionsData {
  status: 'HALTED' | 'DEGRADED' | 'LIVE' | 'UNKNOWN';
  kill_switch: { armed: boolean; path: string };
  broker: {
    state: string;
    consecutive_failures: number;
    last_probe_at: string | null;
    override_state: string | null;
  } | null;
  active_halts: Halt[];
  positions: Position[];
  signals: Signal[];
  intent_states: Record<string, number>;
  summary: {
    total_signals: number;
    open_positions: number;
    filled: number;
    failed: number;
  };
  caps: {
    max_contracts_per_trade: number;
    max_open_positions: number;
    per_trade_max_loss: number;
    daily_max_loss: number;
    market_close_time: string;
    zero_dte_cutoff_time: string;
    source: string;
  };
  data_availability: { missing: string[]; pnl_available: boolean };
  error?: string;
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
  return `${Math.floor(diffHr / 24)}d ago`;
}

const STATUS_META: Record<
  OptionsData['status'],
  { label: string; color: string; ring: string; desc: string }
> = {
  HALTED: {
    label: 'HALTED',
    color: 'text-destructive',
    ring: 'border-destructive/40 bg-destructive/10',
    desc: 'Kill-switch armed or active halt — no orders will execute',
  },
  DEGRADED: {
    label: 'DEGRADED',
    color: 'text-warning',
    ring: 'border-warning/40 bg-warning/10',
    desc: 'Broker health degraded — trading paused until probe recovers',
  },
  LIVE: {
    label: 'LIVE',
    color: 'text-success',
    ring: 'border-success/40 bg-success/10',
    desc: 'Broker healthy, no halts — bot armed for live execution',
  },
  UNKNOWN: {
    label: 'UNKNOWN',
    color: 'text-muted-foreground',
    ring: 'border-border bg-muted/20',
    desc: 'Broker state has not been probed yet',
  },
};

function StatePill({ state }: { state: string }) {
  const map: Record<string, string> = {
    FILLED: 'bg-success/15 text-success border-success/30',
    RESOLVED_FILLED: 'bg-success/15 text-success border-success/30',
    ACKED: 'bg-primary/15 text-primary border-primary/30',
    SUBMITTING: 'bg-primary/15 text-primary border-primary/30',
    RESERVED: 'bg-muted/40 text-muted-foreground border-border',
    FAILED: 'bg-destructive/15 text-destructive border-destructive/30',
    CANCELED: 'bg-muted/40 text-muted-foreground border-border',
    RESOLVED_CANCELED: 'bg-muted/40 text-muted-foreground border-border',
    UNKNOWN_BROKER_STATE: 'bg-warning/15 text-warning border-warning/30',
  };
  return (
    <span
      className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold font-mono ${
        map[state] ?? 'bg-muted/40 text-muted-foreground border-border'
      }`}
    >
      {state}
    </span>
  );
}

export default function OptionsPage() {
  const [data, setData] = useState<OptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/options');
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
      <div className="space-y-6 animate-pulse">
        <div className="h-7 w-56 rounded bg-muted/40" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 rounded-xl bg-muted/30" />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-muted/30" />
      </div>
    );
  }

  if (!data || data.error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Alpaca Options</h1>
        <Card>
          <CardContent className="flex items-center gap-2 text-destructive">
            <IconAlertTriangle size={16} />
            <span>{error || data?.error || 'Failed to load options bot state.'}</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sm = STATUS_META[data.status];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Alpaca Options</h1>
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${sm.ring} ${sm.color}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${data.status === 'LIVE' ? 'bg-success animate-pulse' : data.status === 'HALTED' ? 'bg-destructive' : 'bg-warning'}`} />
              {sm.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
            0DTE Discord signal bot · {data.summary.open_positions} open ·{' '}
            {data.summary.total_signals} signals seen
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            fetchData();
          }}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
        >
          <IconRefresh size={14} />
          Refresh
        </button>
      </div>

      {/* Top bento row: Kill-switch + Broker + Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Kill switch — the loudest tile */}
        <Card
          size="sm"
          className={
            data.kill_switch.armed
              ? 'hud-panel border-destructive/40 bg-destructive/5'
              : 'hud-panel border-success/30 bg-success/5'
          }
        >
          <CardContent className="flex items-center gap-3">
            <div
              className={`rounded-lg p-2.5 ${data.kill_switch.armed ? 'bg-destructive/15' : 'bg-success/15'}`}
            >
              {data.kill_switch.armed ? (
                <IconShieldLock size={22} className="text-destructive" />
              ) : (
                <IconShieldCheck size={22} className="text-success" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Kill Switch
              </p>
              <p
                className={`text-xl font-bold font-mono ${data.kill_switch.armed ? 'text-destructive' : 'text-success'}`}
              >
                {data.kill_switch.armed ? 'ARMED' : 'CLEAR'}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {data.kill_switch.armed ? 'Orders blocked' : 'Path clear'}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Broker health */}
        <Card size="sm" className="hud-panel">
          <CardContent className="flex items-center gap-3">
            <div className="rounded-lg p-2.5 bg-muted/40">
              <IconPlugConnected
                size={22}
                className={
                  data.broker?.state === 'HEALTHY'
                    ? 'text-success'
                    : data.broker?.state === 'DEGRADED'
                      ? 'text-warning'
                      : data.broker?.state === 'DOWN'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                }
              />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Broker Health
              </p>
              <p className="text-xl font-bold font-mono">
                {data.broker?.state ?? 'UNKNOWN'}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {data.broker
                  ? `${data.broker.consecutive_failures} fails · probe ${timeAgo(data.broker.last_probe_at)}`
                  : 'no probe data'}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Overall status */}
        <Card size="sm" className={`hud-panel ${sm.ring}`}>
          <CardContent className="flex items-center gap-3">
            <div className="rounded-lg p-2.5 bg-muted/40">
              <IconActivity size={22} className={sm.color} />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Bot Status
              </p>
              <p className={`text-xl font-bold font-mono ${sm.color}`}>{sm.label}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {data.active_halts.length} active halt
                {data.active_halts.length !== 1 ? 's' : ''}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status banner */}
      <div className={`flex items-start gap-3 rounded-lg border p-3 ${sm.ring}`}>
        <IconCircleDot size={18} className={`${sm.color} shrink-0 mt-0.5`} />
        <div>
          <p className={`text-sm font-medium ${sm.color}`}>System: {sm.label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{sm.desc}</p>
        </div>
      </div>

      {/* Mid row: Positions + Risk caps */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Open positions */}
        <Card className="lg:col-span-3">
          <CardHeader className="border-b">
            <CardTitle>Open Positions</CardTitle>
            <CardDescription>
              Held contracts (drift-detector SSOT) · {data.positions.length} open
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Confirmation</TableHead>
                  <TableHead className="text-right">Held</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.positions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No open positions
                    </TableCell>
                  </TableRow>
                ) : (
                  data.positions.map((p) => (
                    <TableRow key={p.symbol}>
                      <TableCell className="font-mono font-medium">{p.symbol}</TableCell>
                      <TableCell className="text-right font-mono">{p.qty}</TableCell>
                      <TableCell>
                        <Badge
                          variant={p.confirmation_state === 'CONFIRMED' ? 'default' : 'secondary'}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {p.confirmation_state}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {timeAgo(p.entered_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Risk caps */}
        <Card className="lg:col-span-2">
          <CardHeader className="border-b">
            <CardTitle>Risk Caps</CardTitle>
            <CardDescription>
              Configured guardrails ({data.caps.source === 'env' ? 'from env' : 'bot defaults'})
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2.5 text-sm">
              {[
                ['Max contracts / trade', String(data.caps.max_contracts_per_trade)],
                ['Max open positions', String(data.caps.max_open_positions)],
                ['Per-trade max loss', `$${data.caps.per_trade_max_loss}`],
                ['Daily max loss', `$${data.caps.daily_max_loss}`],
                ['Market close', data.caps.market_close_time],
                ['0DTE cutoff', data.caps.zero_dte_cutoff_time],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono font-medium">{v}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* P&L placeholder — explicitly labeled, not fabricated */}
      <Card className="border-dashed">
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
          <IconAlertTriangle size={16} className="shrink-0 text-warning" />
          <span>
            <span className="font-medium text-foreground">P&amp;L not wired yet.</span> The
            options bot&apos;s realized P&amp;L lives in Alpaca + the reconcile script, not in the
            local state DBs read here. Showing a number would be fabricated — this stays a
            placeholder until the Alpaca account endpoint is wired.
          </span>
        </CardContent>
      </Card>

      {/* Active halts */}
      {data.active_halts.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-destructive">
              <IconShieldLock size={16} /> Active Halts
            </CardTitle>
            <CardDescription>Conditions currently blocking execution</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.active_halts.map((h) => (
                  <TableRow key={h.halt_id}>
                    <TableCell className="font-mono text-xs">{h.source_module}</TableCell>
                    <TableCell className="font-mono text-xs text-destructive">
                      {h.reason_code}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-72 truncate">
                      {h.reason_text}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {timeAgo(h.triggered_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent signals / intents */}
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Recent Signals</CardTitle>
          <CardDescription>
            Parsed Discord option calls and their order-intent state
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Signal</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Contracts</TableHead>
                <TableHead className="text-right">When</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.signals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No signals recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                data.signals.map((s) => (
                  <TableRow key={s.intent_id}>
                    <TableCell className="font-mono text-xs">
                      {s.raw_text ||
                        [s.ticker, s.expiry, s.strike && `${s.strike}${s.right ?? ''}`, s.price && `@${s.price}`]
                          .filter(Boolean)
                          .join(' ') ||
                        '--'}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {(s.action ?? '--').toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatePill state={s.state} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {s.contracts ?? '--'}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {timeAgo(s.created_at)}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                      {s.failure_reason || '--'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {data.data_availability.missing.length > 0 && (
        <p className="text-[11px] text-muted-foreground font-mono">
          Missing state DBs: {data.data_availability.missing.join(', ')}
        </p>
      )}
    </div>
  );
}
