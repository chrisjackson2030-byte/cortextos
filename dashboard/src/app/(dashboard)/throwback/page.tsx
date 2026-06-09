import { IconHistory, IconSnowflake } from '@tabler/icons-react';
import { getColdProjects, getThrowback, type ColdProject } from '@/lib/data/command-center';

export const dynamic = 'force-dynamic';

const STATE_STYLE: Record<string, string> = {
  cooling: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  cold: 'text-sky-400 border-sky-400/30 bg-sky-400/10',
  frozen: 'text-blue-300 border-blue-300/30 bg-blue-300/10',
};

function Card({ p }: { p: ColdProject }) {
  return (
    <div className="hud-panel rounded-xl border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug">{p.title}</h3>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${STATE_STYLE[p.state] ?? ''}`}
        >
          {p.state}
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
        <span>{p.source}</span>
        <span>
          {p.daysSince}d ago · {p.lastTouched}
        </span>
      </div>
    </div>
  );
}

export default async function ThrowbackPage() {
  const throwback = getThrowback();
  const cold = getColdProjects(30);

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <IconHistory size={20} className="text-primary" /> Throwback
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Things you said you&apos;d do, surfaced before they&apos;re forgotten. Out of sight = out
          of mind — so they come back onto the screen.
        </p>
      </div>

      {throwback && (
        <div className="hud-panel rounded-xl border bg-primary/5 border-primary/30 p-5">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-primary mb-2">
            <IconSnowflake size={14} /> Remember when you said…
          </div>
          <h2 className="text-lg font-medium">{throwback.title}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            From {throwback.source} · last touched {throwback.daysSince} days ago (
            {throwback.lastTouched})
          </p>
        </div>
      )}

      {cold.length ? (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">
            Going cold ({cold.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cold.map((p, i) => (
              <Card key={i} p={p} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing has gone cold — everything on the registries is recent.
        </p>
      )}
    </div>
  );
}
