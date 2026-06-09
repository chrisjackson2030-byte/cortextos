import { IconBrain, IconHistory, IconSnowflake, IconClockPause } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { ColdProject, LeftOff } from '@/lib/data/command-center';

// The memory-prosthetic zone B asked for: where we left off, projects gone cold,
// and a throwback. Out of sight = out of mind, so this forces the forgotten
// things back onto the screen.
export function DebriefMemory({
  leftOff,
  coldProjects,
  throwback,
}: {
  leftOff: LeftOff[];
  coldProjects: ColdProject[];
  throwback: ColdProject | null;
}) {
  return (
    <div className="hud-panel rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="rounded-md bg-primary/15 p-1.5">
          <IconBrain size={16} className="text-primary" />
        </span>
        <h3 className="text-sm font-semibold">Debrief &amp; Memory</h3>
      </div>

      {/* Left off */}
      <Section icon={<IconHistory size={12} />} label="Where we left off">
        {leftOff.length ? (
          <ul className="space-y-1">
            {leftOff.map((l, i) => (
              <li key={i} className="text-xs text-foreground/90 leading-snug">
                {l.line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No recent checkpoint.</p>
        )}
      </Section>

      {/* Cold projects */}
      <Section icon={<IconClockPause size={12} />} label="Cold — get back to this?">
        {coldProjects.length ? (
          <ul className="space-y-1">
            {coldProjects.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-foreground/90">{p.title}</span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    p.state === 'frozen'
                      ? 'bg-destructive/15 text-destructive'
                      : p.state === 'cold'
                        ? 'bg-warning/15 text-warning'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {p.state} {p.daysSince}d
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing cold — all projects warm.</p>
        )}
      </Section>

      {/* Throwback */}
      {throwback && (
        <Section icon={<IconSnowflake size={12} />} label="Throwback — remember this?">
          <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
            <p className="text-xs text-foreground/90 leading-snug">{throwback.title}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              last touched {throwback.lastTouched} · {throwback.daysSince} days ago
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center gap-1 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
