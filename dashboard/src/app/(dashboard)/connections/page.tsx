import { IconAffiliate } from '@tabler/icons-react';
import { getConnections, type Connection } from '@/lib/data/command-center';

export const dynamic = 'force-dynamic';

function Card({ c }: { c: Connection }) {
  return (
    <div className="hud-panel rounded-xl border bg-card p-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="text-sm font-medium leading-snug text-right">
          {c.a}
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">
            {c.sourceA}
          </div>
        </div>
        <IconAffiliate size={18} className="text-primary shrink-0" />
        <div className="text-sm font-medium leading-snug">
          {c.b}
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">
            {c.sourceB}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 justify-center border-t border-border/50 pt-3">
        <span className="text-[11px] text-muted-foreground mr-1">shared:</span>
        {c.shared.map((t) => (
          <span
            key={t}
            className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

export default async function ConnectionsPage() {
  const connections = getConnections(16);

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <IconAffiliate size={20} className="text-primary" /> Connections
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Non-obvious links between things you&apos;ve filed — surfaced by shared themes. Every link
          shows the terms both items share, so the connection is explainable, not a guess.
        </p>
      </div>

      {connections.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {connections.map((c, i) => (
            <Card key={i} c={c} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No connections found yet — once a few more ideas and deferred items share themes,
          they&apos;ll link up here.
        </p>
      )}
    </div>
  );
}
