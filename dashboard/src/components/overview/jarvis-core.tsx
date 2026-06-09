'use client';

import { cn } from '@/lib/utils';

interface CoreStat {
  label: string;
  value: string | number;
  accent?: 'primary' | 'success' | 'warning' | 'destructive' | 'muted';
}

interface JarvisCoreProps {
  /** Big center label, e.g. "ONLINE" */
  status: string;
  /** Sub-line under the status, e.g. "9/9 agents · 4 active" */
  subline: string;
  /** Is the system fully healthy (drives the reactor color) */
  healthy?: boolean;
  /** Surrounding stat tiles (rendered around the core) */
  stats: CoreStat[];
}

const accentText: Record<NonNullable<CoreStat['accent']>, string> = {
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-foreground',
};

/**
 * The "Jarvis core" — a central arc-reactor hero. Keeps B's liked
 * center-of-the-room look but surrounds it with dense live stats so there
 * is no dead space.
 */
export function JarvisCore({ status, subline, healthy = true, stats }: JarvisCoreProps) {
  return (
    <div className="hud-panel relative overflow-hidden rounded-2xl border bg-card">
      {/* Ambient grid + glow backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 42%, oklch(0.72 0.18 210 / 0.10), transparent 55%), linear-gradient(oklch(0.72 0.18 210 / 0.05) 1px, transparent 1px), linear-gradient(90deg, oklch(0.72 0.18 210 / 0.05) 1px, transparent 1px)',
          backgroundSize: '100% 100%, 40px 40px, 40px 40px',
        }}
      />

      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-6 p-6 lg:p-8">
        {/* Left stat column */}
        <div className="grid grid-cols-2 gap-3 order-2 lg:order-1">
          {stats.slice(0, Math.ceil(stats.length / 2)).map((s) => (
            <StatTile key={s.label} stat={s} />
          ))}
        </div>

        {/* Center reactor */}
        <div className="order-1 lg:order-2 flex flex-col items-center justify-center py-2">
          <div className="relative flex h-44 w-44 items-center justify-center">
            {/* Outer rotating ring */}
            <div
              className={cn(
                'absolute inset-0 rounded-full border-2 border-dashed',
                healthy ? 'border-primary/30' : 'border-warning/40',
              )}
              style={{ animation: 'reactor-spin 18s linear infinite' }}
            />
            {/* Mid ring (counter-rotating) */}
            <div
              className={cn(
                'absolute inset-4 rounded-full border',
                healthy ? 'border-primary/25' : 'border-warning/30',
              )}
              style={{ animation: 'reactor-spin-rev 12s linear infinite' }}
            />
            {/* Core disc */}
            <div
              className={cn(
                'relative flex h-28 w-28 items-center justify-center rounded-full',
                healthy ? 'arc-glow' : '',
              )}
              style={{
                background: healthy
                  ? 'radial-gradient(circle, oklch(0.72 0.18 210 / 0.35) 0%, oklch(0.72 0.18 210 / 0.08) 60%, transparent 75%)'
                  : 'radial-gradient(circle, oklch(0.78 0.16 66 / 0.30) 0%, oklch(0.78 0.16 66 / 0.06) 60%, transparent 75%)',
              }}
            >
              <span
                className={cn(
                  'text-5xl drop-shadow-[0_0_14px_oklch(0.72_0.18_210/0.7)]',
                  healthy ? 'text-primary' : 'text-warning',
                )}
              >
                ⬡
              </span>
            </div>
          </div>
          <div className="mt-3 text-center">
            <p
              className={cn(
                'text-2xl font-bold tracking-[0.25em] font-mono',
                healthy ? 'text-primary' : 'text-warning',
              )}
            >
              {status}
            </p>
            <p className="mt-1 text-xs text-muted-foreground font-mono">{subline}</p>
          </div>
        </div>

        {/* Right stat column */}
        <div className="grid grid-cols-2 gap-3 order-3">
          {stats.slice(Math.ceil(stats.length / 2)).map((s) => (
            <StatTile key={s.label} stat={s} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatTile({ stat }: { stat: CoreStat }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5 backdrop-blur-sm">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {stat.label}
      </p>
      <p
        className={cn(
          'mt-0.5 text-xl font-bold font-mono tabular-nums',
          accentText[stat.accent ?? 'muted'],
        )}
      >
        {stat.value}
      </p>
    </div>
  );
}
