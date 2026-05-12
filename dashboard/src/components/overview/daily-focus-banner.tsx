import { IconTarget, IconAlertCircle, IconCalendar } from '@tabler/icons-react';
import { TimeAgo } from '@/components/shared/time-ago';

interface DailyFocusBannerProps {
  dailyFocus?: string;
  dailyFocusSetAt?: string;
  bottleneck?: string;
}

export function DailyFocusBanner({ dailyFocus, dailyFocusSetAt, bottleneck }: DailyFocusBannerProps) {
  if (!dailyFocus && !bottleneck) return null;

  return (
    <div className="space-y-2">
      {dailyFocus && (
        <div className="hud-panel flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 dark:shadow-[0_0_12px_oklch(0.72_0.18_210/0.15)]">
          <IconTarget size={16} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                Daily Focus
              </span>
              {dailyFocusSetAt && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <IconCalendar size={10} />
                  <TimeAgo date={dailyFocusSetAt} className="text-[10px] text-muted-foreground" />
                </span>
              )}
            </div>
            <p className="text-sm text-foreground leading-snug">{dailyFocus}</p>
          </div>
        </div>
      )}

      {bottleneck && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3">
          <IconAlertCircle size={16} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-warning block mb-0.5">
              Bottleneck
            </span>
            <p className="text-sm text-foreground leading-snug">{bottleneck}</p>
          </div>
        </div>
      )}
    </div>
  );
}
