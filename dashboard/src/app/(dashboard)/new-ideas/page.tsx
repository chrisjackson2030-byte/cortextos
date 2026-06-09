import { IconBulb } from '@tabler/icons-react';
import { getNewIdeas, type IdeaItem } from '@/lib/data/command-center';

export const dynamic = 'force-dynamic';

const SOURCE_STYLE: Record<string, string> = {
  'idea-inbox': 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  reels: 'text-fuchsia-400 border-fuchsia-400/30 bg-fuchsia-400/10',
  'open-question': 'text-amber-400 border-amber-400/30 bg-amber-400/10',
};

function freshness(days: number | null): string {
  if (days === null) return 'undated';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function Row({ idea }: { idea: IdeaItem }) {
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

export default async function NewIdeasPage() {
  const ideas = getNewIdeas(24);
  const freshThisWeek = ideas.filter((i) => i.daysSince != null && i.daysSince < 7).length;

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <IconBulb size={20} className="text-primary" /> New Ideas
          </h1>
          <span className="text-xs text-muted-foreground rounded-md border border-border px-2 py-1">
            {ideas.length} captured · {freshThisWeek} this week
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          What just landed — freshest first. Captured from the idea inbox, reel queue, and open
          questions so nothing you floated disappears.
        </p>
      </div>

      {ideas.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ideas.map((idea, i) => (
            <Row key={i} idea={idea} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No ideas captured yet — they&apos;ll appear here as they land in the inbox registries.
        </p>
      )}
    </div>
  );
}
