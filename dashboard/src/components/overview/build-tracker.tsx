import { IconTools, IconArrowRight } from '@tabler/icons-react';
import type { BuildTracker as BuildTrackerData } from '@/lib/data/command-center';

// Thin always-visible ribbon: where the Jarvis system itself is in its
// development roadmap. Present for object-permanence, never loud.
export function BuildTracker({ data }: { data: BuildTrackerData | null }) {
  if (!data || !data.current) return null;
  const { stage, current, shipped, next } = data;

  return (
    <div className="hud-panel flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-4 py-2.5 text-xs">
      <span className="flex items-center gap-1.5 font-semibold text-primary">
        <IconTools size={14} />
        Jarvis Build
      </span>
      {stage && (
        <span className="rounded-md bg-primary/10 px-2 py-0.5 font-medium text-primary">{stage}</span>
      )}
      <span className="text-muted-foreground">
        <span className="font-mono uppercase">{current.id}</span>{' '}
        <span className="font-medium text-foreground">{current.title}</span>
        {current.targetDate && <span className="ml-1 text-muted-foreground">({current.targetDate})</span>}
      </span>

      {shipped.length > 0 && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <span className="text-success">✓ shipped:</span>
          {shipped.map((s, i) => (
            <span key={i} className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
              {s.length > 28 ? s.slice(0, 28) + '…' : s}
            </span>
          ))}
        </span>
      )}

      {next && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <IconArrowRight size={12} />
          next: <span className="font-medium text-foreground">{next.title}</span>
          {next.targetDate && <span className="text-muted-foreground">({next.targetDate})</span>}
        </span>
      )}
    </div>
  );
}
