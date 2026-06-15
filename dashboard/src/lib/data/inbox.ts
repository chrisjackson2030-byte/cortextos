// cortextOS Dashboard — Inbox data fetchers
// The one place "things waiting on B" are assembled from the LIVE registries:
//   - open questions   → orgs/main/memory/shared/open-questions.md  (actively written)
//   - open decisions   → orgs/main/agents/jarvis/state/ideas-decisions.json
//   - pending approvals come from @/lib/data/approvals (sqlite), joined by callers.
//
// Replaces the dead `state/pending-b-decisions.md` source (frozen Jun 3, queue
// "(empty)") that left the voice page's AWAITING YOUR INPUT panel permanently blank.
//
// All reads are defensive: a missing/garbled file yields an empty result.

import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

const ORG = 'main';

function sharedDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'memory', 'shared');
}

function jarvisStateDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'agents', 'jarvis', 'state');
}

function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

export interface InboxItem {
  /** short label shown in lists */
  title: string;
  /** full text shown on expand */
  detail: string;
  /** where it came from: 'open-question' | 'decision' | 'approval' */
  source: string;
  /** ISO date if known */
  date: string | null;
  ageDays: number | null;
}

function ageDays(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function stripMd(s: string): string {
  return s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** Map a pending approval (from @/lib/data/approvals) into an InboxItem. */
export function approvalToInboxItem(a: {
  title: string;
  description?: string;
  agent?: string;
  created_at?: string;
}): InboxItem {
  return {
    title: a.title,
    detail: [a.description, a.agent ? `from ${a.agent}` : ''].filter(Boolean).join(' — '),
    source: 'approval',
    date: a.created_at ?? null,
    ageDays: ageDays(a.created_at ?? null),
  };
}

/**
 * Open questions from memory/shared/open-questions.md. Two formats coexist:
 *   - `- [YYYY-MM-DD] [status: open] **Question** context...`
 *   - `## [open-q] Title` section headers (newer quick-filed entries)
 * Only status:open bullet entries are returned (resolved/investigating skipped
 * unless investigating — those still need B awareness, so they're included).
 */
export function getOpenQuestions(): InboxItem[] {
  const raw = readSafe(path.join(sharedDir(), 'open-questions.md'));
  if (!raw) return [];
  const out: InboxItem[] = [];

  for (const line of raw.split('\n')) {
    const m = line.match(
      /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\[status:\s*(open|investigating)\]\s*(.+)$/i,
    );
    if (m) {
      const full = stripMd(m[3]);
      // Title = bolded question if present, else first sentence
      const bold = m[3].match(/\*\*(.+?)\*\*/);
      const title = stripMd(bold ? bold[1] : full.split(/(?<=[.?])\s/)[0]).slice(0, 140);
      out.push({
        title,
        detail: full,
        source: 'open-question',
        date: m[1],
        ageDays: ageDays(m[1]),
      });
      continue;
    }
    const h = line.match(/^#{2,3}\s+\[open-q\]\s*(.+)$/i);
    if (h) {
      const title = stripMd(h[1]).slice(0, 140);
      out.push({ title, detail: stripMd(h[1]), source: 'open-question', date: null, ageDays: null });
    }
  }
  return out;
}

/**
 * Open decisions from jarvis/state/ideas-decisions.json (status === 'open').
 */
export function getOpenDecisions(): InboxItem[] {
  const raw = readSafe(path.join(jarvisStateDir(), 'ideas-decisions.json'));
  if (!raw) return [];
  let data: { decisions?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  return (data.decisions ?? [])
    .filter((d) => d.status === 'open')
    .map((d) => {
      const asked = typeof d.asked_at === 'string' ? d.asked_at : null;
      return {
        title: String(d.question ?? '').slice(0, 140),
        detail: [d.question, d.context].filter(Boolean).join(' — '),
        source: 'decision',
        date: asked,
        ageDays: ageDays(asked),
      };
    });
}

export interface RegistryIdea {
  id: string;
  title: string;
  detail: string;
  status: string;
  source: string;
  filed: string | null;
}

/**
 * Tracked ideas from the ideas-decisions.json registry (with status chips:
 * queued / vetting / in-progress / done...). Kept distinct from the markdown
 * idea-inbox feed — this is the curated/triaged registry.
 */
export function getRegistryIdeas(): RegistryIdea[] {
  const raw = readSafe(path.join(jarvisStateDir(), 'ideas-decisions.json'));
  if (!raw) return [];
  let data: { ideas?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  return (data.ideas ?? []).map((i, idx) => ({
    id: String(i.id ?? idx),
    title: String(i.title ?? ''),
    detail: String(i.detail ?? ''),
    status: String(i.status ?? ''),
    source: String(i.source ?? ''),
    filed: typeof i.filed === 'string' ? i.filed : null,
  }));
}
