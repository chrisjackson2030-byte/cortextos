'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { HUNT_LEADS, type LeadStage } from '@/lib/strategy-registry';

// Strategy funnel + graveyard (B-Model redesign #1 MISSING): count EVERYTHING tried +
// show every killed edge with why. Merges live/paper DB lanes (/api/strategy-performance)
// with the curated edge-hunt leads (strategy-registry). "I'd like to see all of them,
// every strategy you test, somewhere — keep track." No fabricated survivors.

interface Lane {
  label: string;
  tag: string;
  backtest?: { verdict: string | null; ledger_excerpt: string | null };
}

interface Item {
  name: string;
  reason: string;
  date?: string;
  source: 'lane' | 'lead';
  kill_type?: 'backtested' | 'pruned';
}

const STAGE_LABEL: Record<LeadStage, string> = {
  killed: 'killed',
  backtesting: 'backtesting',
  queued: 'queued',
  blocked: 'blocked (needs data)',
  research: 'research',
};

export function StrategyPipeline() {
  const [lanes, setLanes] = useState<Lane[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/strategy-performance')
        .then((r) => r.json())
        .then((j) => alive && setLanes(j.strategies ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!lanes) return <div className="h-40 animate-pulse rounded-xl bg-muted/30" />;

  // ── Graveyard: killed DB lanes + killed registry leads (dedup lanes by name) ──
  const killedLanes: Item[] = [];
  const seen = new Set<string>();
  for (const l of lanes) {
    if (l.backtest?.verdict === 'killed' && !seen.has(l.label)) {
      seen.add(l.label);
      killedLanes.push({
        name: l.label,
        reason: l.backtest.ledger_excerpt ?? 'killed OOS',
        source: 'lane',
        kill_type: 'backtested', // live/paper lanes that died ran the full funnel
      });
    }
  }
  const killedLeads: Item[] = HUNT_LEADS.filter((x) => x.stage === 'killed').map((x) => ({
    name: x.name,
    reason: x.reason,
    date: x.date,
    source: 'lead',
    kill_type: x.kill_type,
  }));
  const graveyard = [...killedLanes, ...killedLeads];

  // ── In the chamber: paper-collecting lanes + non-killed leads (backtesting/queued/…) ──
  const collecting: Item[] = lanes
    .filter((l) => l.tag === 'paper-live' && l.backtest?.verdict !== 'killed')
    .filter((l) => {
      if (seen.has(l.label)) return false;
      seen.add(l.label);
      return true;
    })
    .map((l) => ({ name: l.label, reason: 'paper — collecting data', source: 'lane' as const }));
  const activeLeads: Item[] = HUNT_LEADS.filter((x) => x.stage !== 'killed').map((x) => ({
    name: `${x.name} · ${STAGE_LABEL[x.stage]}`,
    reason: x.reason,
    date: x.date,
    source: 'lead' as const,
  }));
  const chamber = [...collecting, ...activeLeads];

  const proven = lanes.filter((l) => l.backtest?.verdict === 'survivor').length;
  const tried = graveyard.length + chamber.length + proven;

  const Stat = ({ n, label, cls }: { n: number; label: string; cls: string }) => (
    <div className="flex flex-col">
      <span className={`text-xl font-bold tabular-nums ${cls}`}>{n}</span>
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Strategy Pipeline — every strategy tested</CardTitle>
        <CardDescription>
          The full hunt: what&apos;s in the chamber, what&apos;s been killed and why. Nothing
          hidden — count everything. A strategy only graduates by clearing the funnel
          (held-out, after fees, beats price + ~2pp).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Funnel counts */}
        <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border/40 pb-4">
          <Stat n={tried} label="tried (all)" cls="text-foreground" />
          <Stat n={chamber.length} label="in chamber" cls="text-amber-400" />
          <Stat n={graveyard.length} label="killed" cls="text-muted-foreground" />
          <Stat n={proven} label="proven" cls={proven > 0 ? 'text-emerald-400' : 'text-foreground'} />
        </div>

        {/* In the chamber */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400/90">
            In the chamber ({chamber.length})
          </div>
          <ul className="space-y-1.5">
            {chamber.map((it, i) => (
              <li key={`c${i}`} className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium text-foreground">{it.name}</span>
                <span className="text-xs text-muted-foreground">{it.reason}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Graveyard */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Graveyard — killed edges ({graveyard.length}) ·{' '}
            {graveyard.filter((g) => g.kill_type === 'backtested').length} backtested ·{' '}
            {graveyard.filter((g) => g.kill_type === 'pruned').length} pruned
          </div>
          <ul className="space-y-1.5">
            {[...graveyard]
              .sort((a, b) => (a.kill_type === 'backtested' ? 0 : 1) - (b.kill_type === 'backtested' ? 0 : 1))
              .map((it, i) => (
                <li key={`g${i}`} className="flex flex-col gap-0.5 text-sm opacity-75">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-foreground line-through decoration-muted-foreground/40">
                      {it.name}
                    </span>
                    {it.kill_type && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                          it.kill_type === 'backtested'
                            ? 'bg-blue-500/15 text-blue-400'
                            : 'bg-muted/40 text-muted-foreground'
                        }`}
                      >
                        {it.kill_type}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {it.reason}
                    {it.date ? ` · ${it.date}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
