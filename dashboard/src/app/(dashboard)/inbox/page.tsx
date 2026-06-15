import Link from 'next/link';
import { IconInbox, IconBulb, IconShieldCheck } from '@tabler/icons-react';
import { getPendingApprovals } from '@/lib/data/approvals';
import { getNewIdeas, type IdeaItem } from '@/lib/data/command-center';
import {
  approvalToInboxItem,
  getOpenDecisions,
  getOpenQuestions,
  getRegistryIdeas,
  type InboxItem,
} from '@/lib/data/inbox';

export const dynamic = 'force-dynamic';

// Inbox — the ONE place B answers things (2026-06-10 overhaul, merges the old
// /decisions + /new-ideas pages). Top: decisions waiting on B, from the LIVE
// sources (pending approvals + open decisions + open questions). Below: recently
// filed ideas from the actively-written registries (idea-inbox / reels), plus the
// tracked idea registry with status chips.

const SOURCE_STYLE: Record<string, string> = {
  'idea-inbox': 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  reels: 'text-fuchsia-400 border-fuchsia-400/30 bg-fuchsia-400/10',
  'open-question': 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  decision: 'text-cyan-400 border-cyan-400/30 bg-cyan-400/10',
  approval: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
};

const STATUS_TONE: Record<string, string> = {
  backseat: 'bg-zinc-500/15 text-zinc-300',
  vetting: 'bg-amber-500/15 text-amber-300',
  queued: 'bg-cyan-500/15 text-cyan-300',
  offered: 'bg-cyan-500/15 text-cyan-300',
  'in-progress': 'bg-blue-500/15 text-blue-300',
  done: 'bg-emerald-500/15 text-emerald-300',
};

function freshness(days: number | null): string {
  if (days === null) return 'undated';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function WaitingRow({ item }: { item: InboxItem }) {
  return (
    <div className="rounded-xl border-l-2 border-amber-400/60 bg-amber-400/[0.04] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{item.title}</p>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${SOURCE_STYLE[item.source] ?? 'text-muted-foreground border-border'}`}
          >
            {item.source}
          </span>
          {item.ageDays != null && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {item.ageDays}d
            </span>
          )}
        </span>
      </div>
      {item.detail && item.detail !== item.title && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
      )}
    </div>
  );
}

function IdeaRow({ idea }: { idea: IdeaItem }) {
  return (
    <div className="hud-panel rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium leading-snug">{idea.title}</h3>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${SOURCE_STYLE[idea.source] ?? 'text-muted-foreground border-border'}`}
        >
          {idea.source}
        </span>
      </div>
      {idea.snippet && (
        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{idea.snippet}</p>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{freshness(idea.daysSince)}</div>
    </div>
  );
}

export default async function InboxPage() {
  const approvals = getPendingApprovals();
  const waiting: InboxItem[] = [
    ...approvals.map(approvalToInboxItem),
    ...getOpenDecisions(),
    ...getOpenQuestions(),
  ];
  const ideas = getNewIdeas(24);
  const registryIdeas = getRegistryIdeas().filter((i) => i.status !== 'done');
  const freshThisWeek = ideas.filter((i) => i.daysSince != null && i.daysSince < 7).length;

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <IconInbox size={20} className="text-primary" /> Inbox
          </h1>
          {waiting.length > 0 && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold tracking-wider text-amber-400">
              {waiting.length} AWAITING YOU
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          The one place you answer things: decisions waiting on you (live approvals + open
          questions), then recently filed ideas — so nothing you floated disappears.
        </p>
      </div>

      {/* ANCHOR: decisions waiting on B */}
      <div className="rounded-2xl border bg-card/50 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <IconShieldCheck size={16} className="text-amber-400" /> Waiting on you
          {approvals.length > 0 && (
            <Link href="/approvals" className="ml-auto text-xs text-primary hover:underline">
              {approvals.length} approval{approvals.length !== 1 ? 's' : ''} →
            </Link>
          )}
        </h2>
        {waiting.length === 0 ? (
          <div className="flex h-16 items-center justify-center text-sm text-muted-foreground">
            Nothing waiting — you&apos;re all caught up.
          </div>
        ) : (
          <div className="space-y-3">
            {waiting.map((item, i) => (
              <WaitingRow key={i} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Recently filed ideas (live markdown registries) */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <IconBulb size={16} className="text-primary" /> Recently filed ideas
          <span className="ml-auto text-xs text-muted-foreground rounded-md border border-border px-2 py-1">
            {ideas.length} captured · {freshThisWeek} this week
          </span>
        </h2>
        {ideas.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ideas.map((idea, i) => (
              <IdeaRow key={i} idea={idea} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No ideas captured yet — they&apos;ll appear here as they land in the inbox registries.
          </p>
        )}
      </div>

      {/* Tracked idea registry (ideas-decisions.json) with status chips */}
      {registryIdeas.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Idea registry — tracked ({registryIdeas.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {registryIdeas.map((i) => (
              <div key={i.id} className="rounded-xl border bg-card px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{i.title}</p>
                  {i.status && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[i.status] ?? 'bg-zinc-500/15 text-zinc-300'}`}
                    >
                      {i.status}
                    </span>
                  )}
                </div>
                {i.detail && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{i.detail}</p>
                )}
                {i.source && (
                  <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                    via {i.source}
                    {i.filed ? ` · ${i.filed}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
