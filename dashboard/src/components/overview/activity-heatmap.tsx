'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconFlame } from '@tabler/icons-react';
import type { HeatmapDay } from '@/lib/data/events';

interface ActivityHeatmapProps {
  data: HeatmapDay[];
}

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ day: HeatmapDay; x: number; y: number } | null>(null);

  const max = Math.max(...data.map((d) => d.count), 1);
  const total = data.reduce((sum, d) => sum + d.count, 0);

  function cellColor(count: number): string {
    const pct = count === 0 ? 6 : Math.round((0.18 + (count / max) * 0.82) * 100);
    return `color-mix(in oklch, var(--primary) ${pct}%, transparent)`;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <IconFlame size={14} />
            30-Day Activity
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {total.toLocaleString()} events
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 relative">
        {/* 30 cells: 6 rows × 5 cols, oldest top-left, newest bottom-right */}
        <div className="grid grid-cols-[repeat(6,1fr)] gap-1">
          {data.map((day) => (
            <div
              key={day.date}
              className="aspect-square rounded-sm cursor-default"
              style={{ backgroundColor: cellColor(day.count) }}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltip({ day, x: rect.left + rect.width / 2, y: rect.top - 8 });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </div>

        {/* Date range labels */}
        <div className="flex justify-between mt-2 text-[10px] text-muted-foreground font-mono">
          <span>{data[0] ? format(new Date(data[0].date + 'T12:00:00'), 'MMM d') : ''}</span>
          <span>Today</span>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-1 mt-1.5 justify-end">
          <span className="text-[10px] text-muted-foreground">Less</span>
          {[6, 30, 55, 75, 100].map((pct) => (
            <div
              key={pct}
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ backgroundColor: `color-mix(in oklch, var(--primary) ${pct}%, transparent)` }}
            />
          ))}
          <span className="text-[10px] text-muted-foreground">More</span>
        </div>

        {/* Floating tooltip */}
        {tooltip && (
          <div
            className="pointer-events-none fixed z-50 rounded-md border bg-card px-2 py-1 text-xs shadow-lg"
            style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
          >
            <span className="font-mono font-medium">{tooltip.day.count}</span>
            <span className="text-muted-foreground ml-1">
              {format(new Date(tooltip.day.date + 'T12:00:00'), 'MMM d')}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
