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
// /revenue — ONE screen for every revenue/edge thread (B 2026-06-12, "done
// right, updates on its own"). Mirrors the edge-engine page pattern: client
// poll of /api/revenue every 30s, freshness surfaced, honest numbers only.
// Order matters: NEEDS YOUR CALL first, then tracks, pipeline, edge scoreboard.
// ─────────────────────────────────────────────────────────────────────────────

interface PendingBItem { source: string; track: string; ask: string; state?: string; queued_at?: string }
interface LedgerCycle { cycle: string; stalled?: string[]; chosen_free_push?: string; b_gate_count?: number; ts?: string }
interface Leash { mode?: string; free_actions?: string[]; b_gate_actions?: string[]; real_money_frozen?: boolean }
interface Track {
  key: string; label: string; status: string; status_as_of: string | null;
  path_to_profit: string; stalled: boolean; last_push: string | null; pending_b: number;
}
interface PipelineIdea { slug: string; title: string; status: string; captured_at?: string; source?: string }
interface RegistryLead { bucket: 'live' | 'watch'; heading: string }
interface StudyVerdict { file: string; date: string; title: string; snippet: string }
interface Payload {
  available: boolean;
  reason?: string;
  generated_at?: string;
  needs_b?: PendingBItem[];
  leash?: Leash | null;
  tracks?: Track[];
  director?: { last_cycle_at: string | null; cycles_24h: number; recent: LedgerCycle[] };
  pipeline?: { total: number; by_status: { status: string; count: number; items: PipelineIdea[] }[] };
  edge?: {
    attempts: number | null; confirmed: number | null; scoreboard: string; live_lead: string;
    state_generated_at: string | null; registry_updated: string | null;
    leads: RegistryLead[]; dead_count: number; verdicts: StudyVerdict[];
  };
  trading?: {
    kalshi: string;
    options: { status: string; equity: number | null; options_level: number | null; updated_at: string | null; kill_switch: boolean } | null;
  };
}

function relAge(iso?: string | null): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'accent' | 'warn' }) {
  const color =
    tone === 'good' ? 'text-emerald-400'
    : tone === 'bad' ? 'text-rose-400'
    : tone === 'warn' ? 'text-amber-300'
    : tone === 'accent' ? 'text-cyan-300'
    : 'text-zinc-100';
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.015] px-4 py-3 ring-1 ring-white/10 shadow-lg shadow-black/30">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  shipped: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/20',
  executing: 'bg-cyan-500/15 text-cyan-300 ring-cyan-400/20',
  approved: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20',
  proposed: 'bg-amber-500/15 text-amber-300 ring-amber-400/20',
  researching: 'bg-sky-500/15 text-sky-300 ring-sky-400/20',
  classified: 'bg-white/5 text-zinc-300 ring-white/10',
  captured: 'bg-white/5 text-zinc-300 ring-white/10',
  parked: 'bg-white/5 text-zinc-400 ring-white/10',
  killed: 'bg-rose-500/10 text-rose-300 ring-rose-400/20',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${STATUS_TONE[status] ?? 'bg-white/5 text-zinc-300 ring-white/10'}`}>
      {status}
    </span>
  );
}

function TrackCard({ t }: { t: Track }) {
  return (
    <div className="flex flex-col rounded-xl bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-4 ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-zinc-100">{t.label}</div>
        <div className="flex items-center gap-1.5">
          {t.pending_b > 0 && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 bg-amber-500/15 text-amber-300 ring-amber-400/20">
              {t.pending_b} on B
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
              t.stalled
                ? 'bg-rose-500/10 text-rose-300 ring-rose-400/20'
                : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/20'
            }`}
          >
            {t.stalled ? 'STALLED' : 'MOVING'}
          </span>
        </div>
      </div>
      <div className="mt-2 text-xs text-zinc-300">{t.status}</div>
      <div className="mt-2 text-xs text-zinc-500">
        <span className="text-zinc-600">Path to profit:</span> {t.path_to_profit}
      </div>
      <div className="mt-auto flex items-center justify-between pt-3 text-[11px] text-zinc-500">
        <span>
          Director last pushed: <span className="tabular-nums text-zinc-400">{t.last_push ? relAge(t.last_push) : 'never'}</span>
        </span>
        {t.status_as_of && (
          <span title={t.status_as_of}>state {relAge(t.status_as_of)}</span>
        )}
      </div>
    </div>
  );
}

export default function RevenuePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/revenue')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000); // B: "updates on its own"
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div className="p-6 text-sm text-rose-400">Failed to load revenue state: {err}</div>;
  if (!data) return <div className="p-6 text-sm text-zinc-500">Loading revenue state…</div>;
  if (!data.available) {
    return <div className="p-6 text-sm text-zinc-500">Revenue feed unavailable{data.reason ? ` — ${data.reason}` : ''}.</div>;
  }

  const needsB = data.needs_b ?? [];
  const tracks = data.tracks ?? [];
  const pipeline = data.pipeline;
  const edge = data.edge;
  const director = data.director;
  const leash = data.leash;
  const options = data.trading?.options ?? null;

  return (
    <div className="space-y-6 p-1">
      {/* Header + freshness */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Revenue</h1>
          <p className="text-xs text-zinc-500">
            Every revenue / edge thread on one screen — auto-refreshes every 30s. Honest numbers only.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">last updated</div>
          <div className="text-xs tabular-nums text-zinc-300" title={data.generated_at}>{relAge(data.generated_at)}</div>
        </div>
      </div>

      {/* NEEDS YOUR CALL — first, always */}
      <div className={`rounded-xl p-4 ring-1 ${needsB.length > 0 ? 'bg-amber-500/[0.07] ring-amber-400/30' : 'bg-white/[0.02] ring-white/10'}`}>
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-semibold text-zinc-100">
            Needs your call
            {needsB.length > 0 && <span className="ml-2 text-amber-300">({needsB.length})</span>}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">money / B-gated decisions</div>
        </div>
        {needsB.length === 0 ? (
          <div className="mt-2 text-xs text-zinc-500">Nothing queued on you right now.</div>
        ) : (
          <div className="mt-3 space-y-2">
            {needsB.map((p, i) => (
              <div key={i} className="rounded-lg bg-black/20 p-3 ring-1 ring-amber-400/15">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-400/20">
                    {p.track}
                  </span>
                  <span className="text-zinc-500">via {p.source}</span>
                  {p.queued_at && <span className="ml-auto tabular-nums text-zinc-500" title={p.queued_at}>queued {relAge(p.queued_at)}</span>}
                </div>
                <div className="mt-1.5 text-sm text-zinc-200">{p.ask}</div>
                {p.state && <div className="mt-1 text-xs text-zinc-400">State: {p.state}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="On B's desk" value={String(needsB.length)} tone={needsB.length > 0 ? 'warn' : 'good'} />
        <Kpi
          label="Real money"
          value={leash?.real_money_frozen ? 'FROZEN' : 'open'}
          tone={leash?.real_money_frozen ? 'bad' : 'good'}
        />
        <Kpi label="Edge attempts" value={edge?.attempts?.toLocaleString() ?? '--'} tone="accent" />
        <Kpi label="Confirmed edges" value={String(edge?.confirmed ?? '--')} tone={(edge?.confirmed ?? 0) > 0 ? 'good' : 'bad'} />
        <Kpi
          label="Options equity"
          value={options?.equity != null ? `$${options.equity.toLocaleString()}` : '--'}
          tone="accent"
        />
      </div>

      {/* Revenue tracks */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Revenue tracks</div>
          {director && (
            <div className="text-[11px] text-zinc-500">
              Revenue Director: {director.cycles_24h} cycles / 24h · last {relAge(director.last_cycle_at)}
            </div>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {tracks.map((t) => <TrackCard key={t.key} t={t} />)}
        </div>
        {leash && (
          <p className="mt-2 text-[11px] text-zinc-500">
            Leash: <span className="text-zinc-400">{leash.mode}</span> · free:{' '}
            {(leash.free_actions ?? []).join(', ')} · B-gated: {(leash.b_gate_actions ?? []).join(', ')}
          </p>
        )}
        <p className="mt-1 text-[11px] text-zinc-600">{data.trading?.kalshi}</p>
      </div>

      {/* Idea pipeline */}
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
          Idea pipeline · {pipeline?.total ?? 0} ideas
        </div>
        {(pipeline?.by_status?.length ?? 0) === 0 ? (
          <div className="rounded-xl bg-white/[0.02] p-4 text-xs text-zinc-500 ring-1 ring-white/10">Pipeline is empty.</div>
        ) : (
          <div className="space-y-2">
            {pipeline!.by_status.map((g) => (
              <div key={g.status} className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-white/10">
                <div className="flex items-center gap-2">
                  <StatusPill status={g.status} />
                  <span className="text-[11px] tabular-nums text-zinc-500">{g.count}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {g.items.map((it) => (
                    <span key={it.slug} className="text-xs text-zinc-300" title={`${it.slug} · captured ${relAge(it.captured_at)}`}>
                      {it.title}
                    </span>
                  ))}
                  {g.count > g.items.length && (
                    <span className="text-xs text-zinc-600">+{g.count - g.items.length} more</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edge scoreboard */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Edge scoreboard (honest — kills included)</div>
          <div className="text-[11px] text-zinc-500" title={edge?.state_generated_at ?? undefined}>
            feed {relAge(edge?.state_generated_at)}
          </div>
        </div>
        {edge?.scoreboard && (
          <p className="mb-2 text-xs text-zinc-300">{edge.scoreboard}</p>
        )}
        {edge?.live_lead && (
          <p className="mb-2 text-xs text-zinc-400"><span className="text-zinc-500">Live lead:</span> {edge.live_lead}</p>
        )}
        {(edge?.leads?.length ?? 0) > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {edge!.leads.map((l, i) => (
              <span
                key={i}
                className={`rounded px-1.5 py-0.5 text-[10px] ring-1 ${
                  l.bucket === 'live'
                    ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20'
                    : 'bg-amber-500/10 text-amber-300 ring-amber-400/20'
                }`}
              >
                {l.heading}
              </span>
            ))}
            {edge!.dead_count > 0 && (
              <span className="rounded px-1.5 py-0.5 text-[10px] ring-1 bg-rose-500/10 text-rose-300 ring-rose-400/20">
                {edge!.dead_count} dead families — do not re-hunt
              </span>
            )}
          </div>
        )}
        <div className="rounded-xl ring-1 ring-white/10 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Study / verdict</TableHead>
                <TableHead>Finding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(edge?.verdicts ?? []).map((v) => (
                <TableRow key={v.file}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-zinc-400">{v.date}</TableCell>
                  <TableCell className="text-xs font-medium text-zinc-200">{v.title}</TableCell>
                  <TableCell className="text-xs text-zinc-400">{v.snippet || '—'}</TableCell>
                </TableRow>
              ))}
              {(edge?.verdicts?.length ?? 0) === 0 && (
                <TableRow><TableCell colSpan={3} className="text-xs text-zinc-500">No study deliverables found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Director recent cycles */}
      {(director?.recent?.length ?? 0) > 0 && (
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Revenue Director — recent cycles</div>
          <div className="rounded-xl ring-1 ring-white/10 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Pushed</TableHead>
                  <TableHead>Stalled tracks</TableHead>
                  <TableHead>B-gates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {director!.recent.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums text-zinc-400" title={c.ts ?? c.cycle}>
                      {relAge(c.ts ?? c.cycle)}
                    </TableCell>
                    <TableCell className="text-xs text-cyan-300">{c.chosen_free_push?.replace(/_/g, ' ') ?? '—'}</TableCell>
                    <TableCell className="text-xs text-zinc-400">{(c.stalled ?? []).join(', ') || 'none'}</TableCell>
                    <TableCell className="text-xs tabular-nums text-zinc-400">{c.b_gate_count ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
