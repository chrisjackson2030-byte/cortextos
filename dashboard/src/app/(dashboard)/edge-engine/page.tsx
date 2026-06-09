'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ─────────────────────────────────────────────────────────────────────────────
// Unified EDGE-ENGINE view (B 2026-06-08) — ONE page for all 3 arenas
// (futures + crypto + prediction), reading the live feed Jarvis regenerates
// (/api/edge-engine -> orgs/main/agents/jarvis/state/edge-engine-state.json).
// Surfaces generated_at as "last updated" so it can't silently go stale.
// ─────────────────────────────────────────────────────────────────────────────

interface SymbolStat { rows: number; start: string; end: string }
interface Arena {
  source: string;
  symbols?: Record<string, SymbolStat>;
  files?: number;
  approx_resolved_markets?: string;
}
interface Family { family: string; arena: string; verdict: string; reason: string }
interface State {
  available: boolean;
  reason?: string;
  generated_at?: string;
  arenas?: Record<string, Arena>;
  attempts_logged?: number;
  families_tested?: Family[];
  proven_edges?: number;
  live_lead?: string;
  scoreboard?: string;
  data_cost?: string;
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

function relAge(iso?: string): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

const ARENA_LABEL: Record<string, string> = {
  futures: 'Futures', crypto: 'Crypto', prediction: 'Prediction',
};

function verdictTone(v: string): string {
  const u = v.toUpperCase();
  if (u.includes('VALIDAT')) return 'bg-amber-500/15 text-amber-300 ring-amber-400/20';
  if (u.includes('REJECT') || u.includes('KILL')) return 'bg-rose-500/10 text-rose-300 ring-rose-400/20';
  if (u.includes('PROVEN') || u.includes('CONFIRM')) return 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/20';
  return 'bg-white/5 text-zinc-300 ring-white/10';
}

function ArenaCard({ name, arena }: { name: string; arena: Arena }) {
  const syms = arena.symbols ? Object.entries(arena.symbols) : [];
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-4 ring-1 ring-white/10">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold text-zinc-100">{ARENA_LABEL[name] ?? name}</div>
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">data</div>
      </div>
      <div className="mt-1 text-xs text-zinc-400">{arena.source}</div>
      {syms.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {syms.map(([sym, s]) => (
            <div key={sym} className="flex items-center justify-between text-xs">
              <span className="font-mono text-zinc-300">{sym}</span>
              <span className="tabular-nums text-zinc-400">{s.rows.toLocaleString()} rows</span>
              <span className="text-zinc-500">{s.start} → {s.end}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-xs text-zinc-400">
          {arena.approx_resolved_markets ?? '—'}{arena.files != null ? ` · ${arena.files} shards` : ''}
        </div>
      )}
    </div>
  );
}

export default function EdgeEnginePage() {
  const [data, setData] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/edge-engine')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000); // live-refresh; feed regenerates each drive cycle
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div className="p-6 text-sm text-rose-400">Failed to load edge-engine state: {err}</div>;
  if (!data) return <div className="p-6 text-sm text-zinc-500">Loading edge-engine state…</div>;
  if (!data.available) {
    return <div className="p-6 text-sm text-zinc-500">Edge-engine feed unavailable{data.reason ? ` — ${data.reason}` : ''}.</div>;
  }

  const arenas = data.arenas ?? {};
  const families = data.families_tested ?? [];

  return (
    <div className="space-y-6 p-1">
      {/* Header + freshness */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Edge Engine</h1>
          <p className="text-xs text-zinc-500">Unified hunt across all 3 arenas — futures · crypto · prediction. Honest scoreboard.</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">last updated</div>
          <div className="text-xs tabular-nums text-zinc-300" title={data.generated_at}>{relAge(data.generated_at)}</div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Attempts Logged" value={data.attempts_logged?.toLocaleString() ?? '--'} tone="accent" />
        <Kpi label="Proven Edges" value={String(data.proven_edges ?? 0)} tone={(data.proven_edges ?? 0) > 0 ? 'good' : 'bad'} />
        <Kpi label="Families Tested" value={String(families.length)} />
        <Kpi label="Live Lead" value={(data.live_lead ?? '—').split(' ')[0].replace(/_/g, ' ')} tone="accent" />
        <Kpi label="Data Cost" value={(data.data_cost ?? '$0').split(' ')[0]} tone="good" />
      </div>

      {data.scoreboard && (
        <p className="text-xs text-zinc-400">
          <span className="text-zinc-500">Scoreboard:</span> {data.scoreboard}
        </p>
      )}

      {/* Per-arena data + freshness */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Data by arena (free / $0)</div>
        <div className="grid gap-3 md:grid-cols-3">
          {Object.entries(arenas).map(([name, arena]) => (
            <ArenaCard key={name} name={name} arena={arena} />
          ))}
        </div>
      </div>

      {/* Family verdict table */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Strategy families — verdicts</div>
        <div className="rounded-xl ring-1 ring-white/10 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Family</TableHead>
                <TableHead>Arena</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {families.map((f) => (
                <TableRow key={f.family}>
                  <TableCell className="text-xs font-medium text-zinc-200">{f.family.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-xs text-zinc-400">{ARENA_LABEL[f.arena] ?? f.arena}</TableCell>
                  <TableCell>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${verdictTone(f.verdict)}`}>
                      {f.verdict}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">{f.reason}</TableCell>
                </TableRow>
              ))}
              {families.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-xs text-zinc-500">No families tested yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {data.live_lead && (
        <p className="text-xs text-zinc-400">
          <span className="text-zinc-500">Live lead:</span> {data.live_lead}
        </p>
      )}
    </div>
  );
}
