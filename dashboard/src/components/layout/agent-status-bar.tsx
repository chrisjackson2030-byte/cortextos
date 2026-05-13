'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface HealthData {
  healthy: number;
  stale: number;
  down: number;
  total: number;
}

export function AgentStatusBar() {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    const poll = () =>
      fetch('/api/health')
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});

    poll();
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!health || health.total === 0) return null;

  const allOnline = health.healthy === health.total;
  const hasDown = health.down > 0;
  const hasStale = health.stale > 0;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[11px] font-mono rounded-full px-2.5 py-0.5 border',
        allOnline
          ? 'text-success bg-success/10 border-success/20'
          : hasDown
          ? 'text-destructive bg-destructive/10 border-destructive/20'
          : 'text-warning bg-warning/10 border-warning/20'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full shrink-0',
          allOnline ? 'bg-success animate-pulse' : hasDown ? 'bg-destructive' : 'bg-warning'
        )}
      />
      <span>
        {health.healthy}/{health.total}
      </span>
      <span className="text-muted-foreground">online</span>
    </div>
  );
}
