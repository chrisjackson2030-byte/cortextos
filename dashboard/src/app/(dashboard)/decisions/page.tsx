'use client';

import { useEffect, useState, useCallback } from 'react';

// Decisions & Ideas board (B 2026-06-04). Fixes the recurring "you ask, I skip, it's
// forgotten" gap. Anchor = Decisions Waiting On You (prominent, can't-miss). Then
// B's filed-but-not-executed ideas. Dark discipline, one accent, semantic colors.

interface Decision {
  id: string; question: string; context?: string; asked_at?: string; age_hours: number | null;
}
interface Idea {
  id: string; title: string; detail?: string; status?: string; source?: string; filed?: string;
}
interface Data {
  available: boolean; reason?: string;
  summary?: { open_decisions: number; ideas_count: number; answered_count: number };
  decisions?: Decision[]; ideas?: Idea[];
}

const STATUS_TONE: Record<string, string> = {
  backseat: 'bg-zinc-500/15 text-zinc-300',
  vetting: 'bg-amber-500/15 text-amber-300',
  queued: 'bg-cyan-500/15 text-cyan-300',
  'in-progress': 'bg-blue-500/15 text-blue-300',
  done: 'bg-emerald-500/15 text-emerald-300',
};

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'alert' | 'accent' }) {
  const color = tone === 'alert' ? 'text-amber-400' : tone === 'accent' ? 'text-cyan-300' : 'text-zinc-100';
  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.06] to-white/[0.015] px-4 py-3 ring-1 ring-white/10 shadow-lg shadow-black/30">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export default function DecisionsPage() {
  const [data, setData] = useState<Data | null>(null);
  const fetchData = useCallback(() => {
    fetch('/api/ideas-decisions').then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (!data) return <div className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />;
  if (!data.available)
    return <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm text-zinc-400">Board unavailable: {data.reason}</div>;

  const s = data.summary!;
  const decisions = data.decisions ?? [];
  const ideas = data.ideas ?? [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Decisions &amp; Ideas</h1>
          <p className="mt-1 text-xs text-zinc-500">Decisions waiting on you + ideas you&apos;ve filed but we haven&apos;t executed — so nothing falls through.</p>
        </div>
        {s.open_decisions > 0 && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold tracking-wider text-amber-300">
            {s.open_decisions} AWAITING YOU
          </span>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Decisions Awaiting You" value={String(s.open_decisions)} tone={s.open_decisions > 0 ? 'alert' : undefined} />
        <Kpi label="Filed Ideas" value={String(s.ideas_count)} tone="accent" />
        <Kpi label="Resolved" value={String(s.answered_count)} />
      </div>

      {/* ANCHOR: Decisions Waiting On You */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">Decisions Waiting On You</h2>
        {decisions.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-sm text-zinc-500">Nothing waiting — you&apos;re all caught up.</div>
        ) : (
          <div className="space-y-3">
            {decisions.map((d) => (
              <div key={d.id} className="rounded-xl border-l-2 border-amber-400/60 bg-amber-400/[0.04] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-snug text-zinc-100">{d.question}</p>
                  {d.age_hours != null && (
                    <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">{d.age_hours}h</span>
                  )}
                </div>
                {d.context && <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{d.context}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filed ideas (not yet executed) */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">Filed Ideas — not yet executed</h2>
        {ideas.length === 0 ? (
          <div className="flex h-16 items-center justify-center text-sm text-zinc-500">No filed ideas.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {ideas.map((i) => (
              <div key={i.id} className="rounded-xl bg-white/[0.02] px-4 py-3 ring-1 ring-white/10">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-100">{i.title}</p>
                  {i.status && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[i.status] ?? 'bg-zinc-500/15 text-zinc-300'}`}>
                      {i.status}
                    </span>
                  )}
                </div>
                {i.detail && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{i.detail}</p>}
                {i.source && <p className="mt-1.5 text-[10px] text-zinc-600">via {i.source}{i.filed ? ` · ${i.filed}` : ''}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
