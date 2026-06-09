// cortextOS Dashboard — Command Center data fetchers
// Surfaces the "second brain" registries that previously lived only in markdown
// files the orchestrator read: cold/forgotten projects, a throwback, where we
// left off last session, and the Jarvis build-roadmap tracker.
//
// All reads are defensive: a missing/garbled file yields an empty result, never
// a thrown error — the dashboard tiles degrade to "nothing to show" gracefully.

import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

const ORG = 'main';
const JARVIS = 'jarvis';

function sharedDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'memory', 'shared');
}
function jarvisStateDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'agents', JARVIS, 'state');
}
function jarvisMemoryDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'agents', JARVIS, 'memory');
}

const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export type ColdState = 'cooling' | 'cold' | 'frozen';

export interface ColdProject {
  title: string;
  lastTouched: string; // ISO date
  daysSince: number;
  state: ColdState;
  source: string; // which registry it came from
  declined: boolean;
}

function classify(days: number): ColdState | null {
  if (days >= 15) return 'frozen';
  if (days >= 8) return 'cold';
  if (days >= 4) return 'cooling';
  return null; // warm — not surfaced
}

/**
 * Parse a markdown registry into projects keyed by ## / ### section headers,
 * using the most-recent YYYY-MM-DD found in each section as "last touched".
 */
function parseRegistry(filePath: string, sourceLabel: string): ColdProject[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: ColdProject[] = [];
  const now = new Date();

  let curTitle: string | null = null;
  let curBody: string[] = [];

  const flush = () => {
    if (!curTitle) return;
    const blob = curTitle + '\n' + curBody.join('\n');
    const matches = [...blob.matchAll(DATE_RE)].map((m) => m[1]).sort();
    const last = matches.length ? matches[matches.length - 1] : null;
    if (last) {
      const d = new Date(last + 'T00:00:00Z');
      if (!isNaN(d.getTime())) {
        const days = daysBetween(d, now);
        const state = classify(days);
        if (state) {
          out.push({
            title: cleanTitle(curTitle),
            lastTouched: last,
            daysSince: days,
            state,
            source: sourceLabel,
            declined: /declined|dropped|rejected/i.test(curTitle),
          });
        }
      }
    }
    curTitle = null;
    curBody = [];
  };

  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      flush();
      curTitle = h[1].trim();
    } else if (curTitle) {
      curBody.push(line);
    }
  }
  flush();
  return out;
}

function cleanTitle(t: string): string {
  return t
    .replace(/\*\*/g, '')
    .replace(/\[(.*?)\]/g, '$1')
    .replace(/\s*\(filed[^)]*\)/i, '')
    .replace(/\s*—\s*Filed.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/**
 * Cold/forgotten projects across deferred-items + idea-inbox, sorted coldest
 * first. Declined/dropped items are excluded (already decided). Capped.
 */
export function getColdProjects(limit = 6): ColdProject[] {
  const dir = sharedDir();
  const items = [
    ...parseRegistry(path.join(dir, 'deferred-items.md'), 'deferred'),
    ...parseRegistry(path.join(dir, 'idea-inbox.md'), 'idea-inbox'),
  ].filter((p) => !p.declined);

  // Dedup by title (keep the most-recently-touched instance)
  const byTitle = new Map<string, ColdProject>();
  for (const p of items) {
    const prev = byTitle.get(p.title.toLowerCase());
    if (!prev || p.daysSince < prev.daysSince) byTitle.set(p.title.toLowerCase(), p);
  }
  return [...byTitle.values()]
    .sort((a, b) => b.daysSince - a.daysSince)
    .slice(0, limit);
}

/**
 * Throwback — the single oldest forgotten idea (frozen, deepest). The "remember
 * when you said…" resurface. Returns null if nothing is old enough.
 */
export function getThrowback(): ColdProject | null {
  const all = getColdProjects(50);
  const frozen = all.filter((p) => p.state === 'frozen');
  const pool = frozen.length ? frozen : all;
  return pool.length ? pool[pool.length === all.length ? all.length - 1 : 0] ?? pool[0] : null;
}

export interface LeftOff {
  line: string;
  date: string | null;
}

/**
 * "Where we left off" — pulls the most recent forward-looking line (Next /
 * Resuming / For next session) from the latest Jarvis daily-memory file.
 */
export function getLeftOff(): LeftOff[] {
  const dir = jarvisMemoryDir();
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
  if (!files.length) return [];
  const latest = files[files.length - 1];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, latest), 'utf-8');
  } catch {
    return [];
  }
  const date = latest.replace('.md', '');
  const out: LeftOff[] = [];
  const re = /^\s*-?\s*(?:\*\*)?(?:Next|Resuming|For next session|Current state|Active threads)(?:\*\*)?\s*:\s*(.+)$/i;
  for (const line of raw.split('\n')) {
    const m = line.match(re);
    if (m && m[1].trim().length > 3) {
      out.push({ line: m[1].replace(/\*\*/g, '').trim().slice(0, 160), date });
    }
  }
  // Most recent entries are at the bottom of the file — show the last few.
  return out.slice(-3).reverse();
}

// ── New Ideas + Connections (the "second brain" surfacing pages) ──────────────
// Additive: these do NOT touch getColdProjects/getThrowback/getLeftOff above.

export interface IdeaItem {
  title: string;
  date: string | null;
  daysSince: number | null;
  source: string;
  snippet: string;
}

/**
 * Parse every ## / ### section of a markdown registry into an item with its
 * most-recent date + a one-line snippet. Unlike parseRegistry (cold-only), this
 * returns ALL sections regardless of age — used for "what's NEW" surfacing.
 */
function parseSectionsRaw(filePath: string, sourceLabel: string): IdeaItem[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: IdeaItem[] = [];
  const now = new Date();

  let curTitle: string | null = null;
  let curBody: string[] = [];

  const flush = () => {
    if (!curTitle) return;
    const blob = curTitle + '\n' + curBody.join('\n');
    const matches = [...blob.matchAll(DATE_RE)].map((m) => m[1]).sort();
    const last = matches.length ? matches[matches.length - 1] : null;
    let daysSince: number | null = null;
    if (last) {
      const d = new Date(last + 'T00:00:00Z');
      if (!isNaN(d.getTime())) daysSince = daysBetween(d, now);
    }
    const snippet =
      curBody
        .map((l) => l.replace(/^[\s\-*>#]+/, '').replace(/\*\*/g, '').trim())
        .find((l) => l.length > 8) ?? '';
    out.push({
      title: cleanTitle(curTitle),
      date: last,
      daysSince,
      source: sourceLabel,
      snippet: snippet.slice(0, 180),
    });
    curTitle = null;
    curBody = [];
  };

  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      flush();
      curTitle = h[1].trim();
    } else if (curTitle) {
      curBody.push(line);
    }
  }
  flush();
  return out;
}

/**
 * New / recent ideas across the inbox registries, newest-first. This is the
 * inverse of getColdProjects — what just landed, not what went cold.
 */
export function getNewIdeas(limit = 14): IdeaItem[] {
  const dir = sharedDir();
  const items = [
    ...parseSectionsRaw(path.join(dir, 'idea-inbox.md'), 'idea-inbox'),
    ...parseSectionsRaw(path.join(dir, 'reel-ideas-inbox.md'), 'reels'),
    ...parseSectionsRaw(path.join(dir, 'open-questions.md'), 'open-question'),
  ].filter((i) => i.title.length > 2 && !/^(index|contents|how to|format)/i.test(i.title));

  // Dedup by title, keep newest
  const byTitle = new Map<string, IdeaItem>();
  for (const i of items) {
    const prev = byTitle.get(i.title.toLowerCase());
    if (!prev || (i.daysSince ?? 9999) < (prev.daysSince ?? 9999))
      byTitle.set(i.title.toLowerCase(), i);
  }
  return [...byTitle.values()]
    .sort((a, b) => (a.daysSince ?? 9999) - (b.daysSince ?? 9999))
    .slice(0, limit);
}

export interface Connection {
  a: string;
  b: string;
  sourceA: string;
  sourceB: string;
  shared: string[]; // the significant terms both items mention — the WHY
}

const STOPWORDS = new Set([
  'jarvis', 'build', 'system', 'this', 'that', 'with', 'from', 'into', 'when',
  'what', 'where', 'will', 'would', 'could', 'should', 'about', 'there', 'their',
  'item', 'items', 'idea', 'ideas', 'note', 'notes', 'thing', 'things', 'agent',
  'agents', 'need', 'needs', 'want', 'wants', 'make', 'made', 'using', 'used',
  'have', 'been', 'were', 'they', 'them', 'then', 'than', 'more', 'most', 'some',
  'phase', 'project', 'projects', 'work', 'working', 'good', 'just', 'like',
  'over', 'also', 'because', 'which', 'while', 'these', 'those', 'each', 'both',
]);

function significantTerms(s: string): Set<string> {
  const terms = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) terms.add(w);
  }
  return terms;
}

/**
 * Connections — the "second brain" link finder. Surfaces non-obvious pairs of
 * items (across deferred-items + idea-inbox + open-questions) that share two or
 * more significant terms, with the shared terms exposed as the WHY. Deterministic
 * (term-overlap, not an LLM guess) so every connection is explainable + honest.
 */
export function getConnections(limit = 10): Connection[] {
  const dir = sharedDir();
  const items = [
    ...parseSectionsRaw(path.join(dir, 'deferred-items.md'), 'deferred'),
    ...parseSectionsRaw(path.join(dir, 'idea-inbox.md'), 'idea-inbox'),
    ...parseSectionsRaw(path.join(dir, 'open-questions.md'), 'open-question'),
  ].filter((i) => i.title.length > 4);

  // Dedup by title
  const seen = new Map<string, IdeaItem>();
  for (const i of items) if (!seen.has(i.title.toLowerCase())) seen.set(i.title.toLowerCase(), i);
  const list = [...seen.values()];

  const terms = list.map((i) => significantTerms(i.title + ' ' + i.snippet));
  const out: Connection[] = [];
  for (let x = 0; x < list.length; x++) {
    for (let y = x + 1; y < list.length; y++) {
      const shared = [...terms[x]].filter((t) => terms[y].has(t));
      if (shared.length >= 2) {
        out.push({
          a: list[x].title,
          b: list[y].title,
          sourceA: list[x].source,
          sourceB: list[y].source,
          shared: shared.slice(0, 5),
        });
      }
    }
  }
  return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
}

export interface BuildTracker {
  stage: string | null;
  current: { id: string; title: string; targetDate: string | null; status: string } | null;
  shipped: string[];
  next: { id: string; title: string; targetDate: string | null } | null;
}

interface LoopIteration {
  title?: string;
  status?: string;
  target_date?: string | null;
  completed_at?: string | null;
}

/**
 * Jarvis build-roadmap tracker from loop-state.json: current iteration, what
 * recently shipped, and what's next.
 */
export function getBuildTracker(): BuildTracker | null {
  const p = path.join(jarvisStateDir(), 'loop-state.json');
  if (!fs.existsSync(p)) return null;
  let data: {
    current_iteration?: string;
    iterations?: Record<string, LoopIteration>;
  };
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
  const iters = data.iterations ?? {};
  const order = Object.keys(iters);
  const curId = data.current_iteration ?? null;
  const cur = curId && iters[curId] ? iters[curId] : null;

  const completed = order
    .filter((k) => iters[k].status === 'complete')
    .map((k) => iters[k].title ?? k);

  // Next = first queued iteration after current
  let next: BuildTracker['next'] = null;
  const curIdx = curId ? order.indexOf(curId) : -1;
  for (let i = curIdx + 1; i < order.length; i++) {
    const it = iters[order[i]];
    if (it.status === 'queued' || it.status === 'in_progress') {
      next = { id: order[i], title: it.title ?? order[i], targetDate: it.target_date ?? null };
      break;
    }
  }

  return {
    stage: 'Stage 1', // current phase-out stage (Jarvis owns execution)
    current: cur
      ? {
          id: curId!,
          title: cur.title ?? curId!,
          targetDate: cur.target_date ?? null,
          status: cur.status ?? 'unknown',
        }
      : null,
    shipped: completed.slice(-3),
    next,
  };
}
