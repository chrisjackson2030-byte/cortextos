'use client';

import { useEffect, useState } from 'react';
import {
  IconHammer,
  IconAlertTriangle,
  IconClockHour4,
  IconActivity,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE A — "Jarvis Build" accountability panel.
// 100% read-only. Every value is fetched from /api/jarvis-build, which maps each
// field to a real file on disk. Missing sources render as "n/a", never faked.
// ─────────────────────────────────────────────────────────────────────────────

interface Iteration {
  id: string;
  title: string;
  status: string;
  type?: string;
  target_date: string | null;
}
interface PlanRow {
  id: string;
  item: string;
  type: string;
  target: string;
}
interface PendingQueueItem {
  item: string;
  queued_at: string | null;
  surface_when: string | null;
  priority: string | null;
}
interface BuildData {
  where: {
    current_iteration: string | null;
    current_iteration_title: string | null;
    status: string | null;
    paused: boolean;
    status_note: string | null;
    complete_iterations: number;
    total_iterations: number;
    pct_complete: number | null;
  };
  countdown: {
    day_of_build: number | null;
    stage2_target: string | null;
    stage3_target: string | null;
    days_to_stage3: number | null;
  };
  iterations: Iteration[];
  plan_rows: PlanRow[];
  issues: {
    pending_decisions: { title: string }[];
    pending_b_queue: PendingQueueItem[];
    gate_denies: string[];
    memory_alarms: string[];
    last_memory_alarm_line: string | null;
  };
  accountability: {
    last_advanced_at: string | null;
    last_checked_at: string | null;
    hours_since_advance: number | null;
    dormant: boolean;
  };
  data_availability: { missing: string[] };
  error?: string;
}

function fmtUtc(iso: string | null): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusDot(status: string): string {
  if (status === 'complete') return 'bg-success';
  if (status === 'active' || status === 'in_progress') return 'bg-primary animate-pulse';
  if (status === 'queued') return 'bg-muted-foreground/40';
  return 'bg-warning';
}

export function JarvisBuildPanel() {
  const [data, setData] = useState<BuildData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/jarvis-build');
        const j = (await r.json()) as BuildData;
        if (!alive) return;
        if (j.error) {
          setFailed(true);
        } else {
          setData(j);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (failed) {
    return (
      <div className="hud-panel rounded-xl border border-warning/30 bg-card p-4 text-xs text-muted-foreground">
        Jarvis Build panel — source unavailable (n/a).
      </div>
    );
  }
  if (!data) {
    return <div className="h-40 animate-pulse rounded-xl bg-muted/20" />;
  }

  const { where, countdown, iterations, issues, accountability } = data;
  const issueCount =
    issues.pending_decisions.length +
    issues.pending_b_queue.length +
    issues.gate_denies.length +
    issues.memory_alarms.length +
    (accountability.dormant ? 1 : 0);

  return (
    <div className="hud-panel rounded-xl border bg-card p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-primary/15 p-1.5">
            <IconHammer size={16} className="text-primary" />
          </span>
          <h3 className="text-sm font-semibold">Jarvis Build — Self-Construction</h3>
          {where.paused && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning border border-warning/20">
              PAUSED
            </span>
          )}
          {accountability.dormant ? (
            <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive border border-destructive/20">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
              DORMANT &gt;24h
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success border border-success/20">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              ADVANCING
            </span>
          )}
        </div>
        {issueCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-0.5 text-[11px] font-medium text-destructive border border-destructive/20">
            <IconAlertTriangle size={12} />
            {issueCount} issue{issueCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Row 1: where we are + countdown + accountability */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Where */}
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Current</p>
          <p className="mt-0.5 text-sm font-bold font-mono">
            {where.current_iteration ?? 'n/a'}
            {where.pct_complete != null && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {where.complete_iterations}/{where.total_iterations} ({where.pct_complete}%)
              </span>
            )}
          </p>
          {/* progress bar — complete vs total iterations */}
          {where.pct_complete != null && (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${where.pct_complete}%` }}
              />
            </div>
          )}
        </div>

        {/* Countdown */}
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <IconClockHour4 size={11} /> Countdown
          </p>
          <p className="mt-0.5 text-sm font-bold font-mono">
            {countdown.day_of_build != null ? `Day ${countdown.day_of_build}` : 'Day n/a'}
            {countdown.days_to_stage3 != null && (
              <span
                className={cn(
                  'ml-2 text-xs font-normal',
                  countdown.days_to_stage3 < 0 ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {countdown.days_to_stage3 < 0
                  ? `${Math.abs(countdown.days_to_stage3)}d overdue`
                  : `${countdown.days_to_stage3}d left`}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Stage 3 ~{countdown.stage3_target ?? 'n/a'}
          </p>
        </div>

        {/* Accountability */}
        <div
          className={cn(
            'rounded-lg border px-3 py-2.5',
            accountability.dormant
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-border/60 bg-background/40',
          )}
        >
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <IconActivity size={11} /> Last loop advance
          </p>
          <p
            className={cn(
              'mt-0.5 text-sm font-bold font-mono',
              accountability.dormant ? 'text-destructive' : 'text-foreground',
            )}
          >
            {fmtUtc(accountability.last_advanced_at)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {accountability.hours_since_advance != null
              ? `${accountability.hours_since_advance}h ago · checked ${fmtUtc(accountability.last_checked_at)}`
              : 'n/a'}
          </p>
        </div>
      </div>

      {/* Row 2: what's being implemented now */}
      <div className="rounded-lg border border-primary/20 bg-primary/[0.03] px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-wider text-primary">Implementing now</p>
        <p className="mt-0.5 text-xs font-medium text-foreground">
          {where.current_iteration_title ?? 'n/a'}
        </p>
        {where.status_note && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {where.status_note}
          </p>
        )}
      </div>

      {/* Row 3: iteration ribbon */}
      <div className="flex flex-wrap gap-1.5">
        {iterations.map((it) => (
          <span
            key={it.id}
            title={`${it.title}${it.target_date ? ` · target ${it.target_date}` : ''} · ${it.status}`}
            className={cn(
              'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono',
              it.id === where.current_iteration
                ? 'border-primary/40 bg-primary/10 text-primary'
                : it.status === 'complete'
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-border/60 bg-background/40 text-muted-foreground',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', statusDot(it.status))} />
            {it.id}
          </span>
        ))}
      </div>

      {/* Row 4: ISSUES */}
      {issueCount > 0 && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/[0.03] px-3 py-2.5 space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
            <IconAlertTriangle size={13} /> Issues &amp; blockers
          </p>

          {accountability.dormant && (
            <Issue
              tag="STALL"
              text={`Loop has not advanced in ${accountability.hours_since_advance}h (>24h dormancy threshold).`}
            />
          )}

          {issues.pending_decisions.map((d, i) => (
            <Issue key={`pd-${i}`} tag="B-DECISION" text={d.title} />
          ))}

          {issues.pending_b_queue.map((q, i) => (
            <Issue
              key={`bq-${i}`}
              tag="QUEUED-FOR-B"
              text={q.item}
              sub={q.priority ? `priority: ${q.priority}` : undefined}
            />
          ))}

          {issues.memory_alarms.map((a, i) => (
            <Issue key={`ma-${i}`} tag="MEMORY-ALARM" text={a} mono />
          ))}

          {issues.gate_denies.map((g, i) => (
            <Issue key={`gd-${i}`} tag="RED-TEAM DENY" text={g} mono />
          ))}
        </div>
      )}

      {/* Missing-source footnote — honesty about n/a fields */}
      {data.data_availability.missing.length > 0 && (
        <p className="text-[10px] text-muted-foreground/70">
          Sources unavailable (shown as n/a): {data.data_availability.missing.join(', ')}
        </p>
      )}
    </div>
  );
}

function Issue({
  tag,
  text,
  sub,
  mono,
}: {
  tag: string;
  text: string;
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-destructive">
        {tag}
      </span>
      <div className="min-w-0">
        <p className={cn('text-foreground/90 break-words', mono && 'font-mono text-[10px]')}>
          {text}
        </p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}
