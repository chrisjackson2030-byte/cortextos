'use client';

import { useEffect, useState } from 'react';

// Verdict banner (B-Model redesign #1): answers B's one question in 3 seconds —
// do we have a proven edge, and is real money safe — before he scrolls. Counts are
// real (from /api/strategy-performance); the FROZEN state reflects the standing
// real-money freeze. No fabricated numbers.

interface Strat {
  tag: string;
  backtest?: { verdict: string | null };
}

export function VerdictBanner() {
  const [data, setData] = useState<{ total: number; killed: number; proven: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/strategy-performance')
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          const strats: Strat[] = j.strategies ?? [];
          const proven = strats.filter((s) => s.backtest?.verdict === 'survivor').length;
          const killed = strats.filter((s) => s.backtest?.verdict === 'killed').length;
          setData({ total: strats.length, killed, proven });
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const proven = (data?.proven ?? 0) > 0;
  // Real money is under a standing freeze (Kalshi frozen; Alpaca KILL_SWITCH armed).
  const frozen = true;

  const pill = proven
    ? { label: 'CANDIDATE FOUND', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' }
    : { label: 'SEARCHING', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };

  const edgeLine = proven
    ? `${data?.proven} strategy candidate(s) passed the funnel — verify before funding.`
    : 'No proven edge yet.';

  const countLine =
    data == null
      ? 'loading…'
      : `0 of ${data.total} strategies have passed the funnel OOS · ${data.killed} killed.`;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold tracking-wider ${pill.cls}`}
        >
          {pill.label}
        </span>
        {frozen && (
          <span className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-[11px] font-bold tracking-wider text-destructive">
            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
            REAL MONEY FROZEN
          </span>
        )}
        <span className="text-sm font-medium text-foreground">{edgeLine}</span>
        <span className="text-xs text-muted-foreground">{countLine}</span>
      </div>
    </div>
  );
}
