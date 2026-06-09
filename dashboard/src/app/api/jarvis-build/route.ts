import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY accountability panel for the Jarvis self-build loop.
// Every field below maps to a real file on disk. Where a source is missing or a
// value can't be derived, we emit null and the UI shows "n/a" — never a fake.
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const JARVIS_ROOT = path.join(HOME, 'cortextos/orgs/main/agents/jarvis');
const LOOP_STATE = path.join(JARVIS_ROOT, 'state/loop-state.json');
const PLAN_MD = path.join(JARVIS_ROOT, 'deliverables/revised-completion-plan-2026-06-03.md');
const PENDING_MD = path.join(JARVIS_ROOT, 'state/pending-b-decisions.md');

const LOG_DIR = path.join(HOME, '.cortextos/default/logs/jarvis');
const VERIFY_GATE_LOG = path.join(LOG_DIR, 'verify-gate.log');
const MEMORY_ALARM_LOG = path.join(LOG_DIR, 'memory-freshness-alarm.log');

interface Iteration {
  id: string;
  title: string;
  status: string;
  type?: string;
  target_date: string | null;
}

function readJson(p: string): Record<string, unknown> | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

// Tail the last N lines of a (possibly large) log file.
function tailLines(p: string, n: number): string[] {
  const txt = readText(p);
  if (txt == null) return [];
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

export async function GET(_request: NextRequest) {
  const missing: string[] = [];

  // ── loop-state.json — the SSOT for where the build is ──
  const loop = readJson(LOOP_STATE);
  if (!loop) missing.push('loop-state.json');

  const schedule = (loop?.schedule as Record<string, unknown> | undefined) ?? {};
  const targetDates = (schedule.target_dates as Record<string, string> | undefined) ?? {};
  const iterationsRaw = (loop?.iterations as Record<string, Record<string, unknown>> | undefined) ?? {};

  // Build an ordered iteration list. Order is the insertion order from the
  // JSON (i, ii, iii, …, M) which mirrors the plan sequence.
  const iterations: Iteration[] = Object.entries(iterationsRaw).map(([id, v]) => ({
    id,
    title: (v.title as string) ?? '',
    status: (v.status as string) ?? 'unknown',
    type: (v.type as string) ?? undefined,
    target_date: (v.target_date as string) ?? targetDates[id] ?? null,
  }));

  const totalIterations = iterations.length;
  const completeIterations = iterations.filter((i) => i.status === 'complete').length;
  const pctComplete =
    totalIterations > 0 ? Math.round((completeIterations / totalIterations) * 100) : null;

  const currentIterationId = (loop?.current_iteration as string) ?? null;
  const currentIterationTitle = (loop?.current_iteration_title as string) ?? null;
  const statusNote = (loop?.status_note as string) ?? null;
  const lastAdvancedAt = (loop?.last_advanced_at as string) ?? null;
  const lastCheckedAt = (loop?.last_checked_at as string) ?? null;
  const status = (loop?.status as string) ?? null;
  const paused = (loop?.paused as boolean) ?? false;

  // ── Dormancy flag: is the loop stale (>24h since last advance)? ──
  let hoursSinceAdvance: number | null = null;
  let dormant = false;
  if (lastAdvancedAt) {
    const ms = Date.now() - new Date(lastAdvancedAt).getTime();
    if (!Number.isNaN(ms)) {
      hoursSinceAdvance = Math.round((ms / 3600000) * 10) / 10;
      dormant = ms > 24 * 3600000;
    }
  }

  // ── Stage-3 countdown from the schedule ──
  const stage3Target = (schedule.stage3_self_running_target as string) ?? null;
  const stage2Target = (schedule.stage2_target as string) ?? null;
  let daysToStage3: number | null = null;
  if (stage3Target) {
    const tgt = new Date(stage3Target + 'T00:00:00Z').getTime();
    if (!Number.isNaN(tgt)) {
      daysToStage3 = Math.ceil((tgt - Date.now()) / (24 * 3600000));
    }
  }
  // "Day N of build" — earliest iteration started_at is the build start.
  let dayOfBuild: number | null = null;
  const startTimes = Object.values(iterationsRaw)
    .map((v) => v.started_at as string | undefined)
    .filter((s): s is string => !!s)
    .map((s) => new Date(s).getTime())
    .filter((t) => !Number.isNaN(t));
  if (startTimes.length > 0) {
    const buildStart = Math.min(...startTimes);
    dayOfBuild = Math.floor((Date.now() - buildStart) / (24 * 3600000)) + 1;
  }

  // ── pending_b_queue (in loop-state) — open decisions queued for B ──
  const pendingQueue = ((loop?.pending_b_queue as Array<Record<string, unknown>>) ?? []).map(
    (q) => ({
      item: (q.item as string) ?? '',
      queued_at: (q.queued_at as string) ?? null,
      surface_when: (q.surface_when as string) ?? null,
      priority: (q.priority as string) ?? null,
    }),
  );

  // ── pending-b-decisions.md — open blockers ──
  // File structure (verified on disk): a "## Queue" section (often "(empty)"),
  // a "## Cleared" section whose RESOLVED items are "### N. …" sub-headings, and
  // dated open decisions appended as "## YYYY-MM-DD — …" headings (which can sit
  // BELOW the Cleared marker). So we surface EVERY "## " heading except the
  // structural ones (Queue / Cleared / the doc title) and ignore "### " items
  // (those are resolved/cleared entries). This avoids under-reporting the real
  // open decisions, which earlier position-based slicing missed.
  const pendingDecisions: { title: string }[] = [];
  const pendingTxt = readText(PENDING_MD);
  if (pendingTxt == null) {
    missing.push('pending-b-decisions.md');
  } else {
    const headingRe = /^##\s+(.+)$/gm; // exactly H2 ("## "), not "### "
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(pendingTxt)) !== null) {
      const title = m[1].trim();
      if (!title) continue;
      if (/^(Queue|Cleared)\b/i.test(title)) continue; // structural sections
      pendingDecisions.push({ title });
    }
  }

  // ── Plan markdown — parse the revised-sequence table for target dates ──
  const planTxt = readText(PLAN_MD);
  if (planTxt == null) missing.push('revised-completion-plan-2026-06-03.md');
  const planRows: { id: string; item: string; type: string; target: string }[] = [];
  if (planTxt) {
    for (const line of planTxt.split('\n')) {
      const t = line.trim();
      // table rows look like: | M | **Memory v2** … | ACTIVATE/PULL | **Jun 4–5** | … |
      if (!t.startsWith('|')) continue;
      const cells = t.split('|').map((c) => c.trim());
      // cells[0]='' cells[1]=id cells[2]=item cells[3]=type cells[4]=target …
      if (cells.length < 5) continue;
      const id = cells[1].replace(/\*/g, '');
      if (!id || id === '#' || /^-+$/.test(id)) continue; // skip header + separator
      planRows.push({
        id,
        item: cells[2].replace(/\*\*/g, ''),
        type: cells[3].replace(/\*\*/g, ''),
        target: cells[4].replace(/\*\*/g, ''),
      });
    }
  }

  // ── ISSUES surfaced from logs ──
  // verify-gate.log: surface recent DENY lines (a red-team gate caught a claim
  // with no source — that's a real accountability signal).
  const gateLines = tailLines(VERIFY_GATE_LOG, 200);
  const gateDenies = gateLines
    .filter((l) => / DENY /.test(l))
    .slice(-8)
    .map((l) => l.trim());
  if (!fs.existsSync(VERIFY_GATE_LOG)) missing.push('verify-gate.log');

  // memory-freshness-alarm.log: surface recent ALARM lines (memory staleness).
  const alarmLines = tailLines(MEMORY_ALARM_LOG, 100);
  const memoryAlarms = alarmLines
    .filter((l) => /ALARM/i.test(l))
    .slice(-5)
    .map((l) => l.trim());
  const lastAlarmLine = alarmLines.length > 0 ? alarmLines[alarmLines.length - 1] : null;
  if (!fs.existsSync(MEMORY_ALARM_LOG)) missing.push('memory-freshness-alarm.log');

  return Response.json({
    where: {
      current_iteration: currentIterationId,
      current_iteration_title: currentIterationTitle,
      status,
      paused,
      status_note: statusNote,
      complete_iterations: completeIterations,
      total_iterations: totalIterations,
      pct_complete: pctComplete,
    },
    countdown: {
      day_of_build: dayOfBuild,
      stage2_target: stage2Target,
      stage3_target: stage3Target,
      days_to_stage3: daysToStage3,
    },
    iterations,
    plan_rows: planRows,
    issues: {
      pending_decisions: pendingDecisions,
      pending_b_queue: pendingQueue,
      gate_denies: gateDenies,
      memory_alarms: memoryAlarms,
      last_memory_alarm_line: lastAlarmLine,
    },
    accountability: {
      last_advanced_at: lastAdvancedAt,
      last_checked_at: lastCheckedAt,
      hours_since_advance: hoursSinceAdvance,
      dormant, // true => RED flag (>24h since loop advanced)
    },
    data_availability: { missing },
  });
}
