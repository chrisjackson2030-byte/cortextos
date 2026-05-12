'use client';

import { useRouter } from 'next/navigation';
import {
  IconRobot,
  IconChecklist,
  IconShieldCheck,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { SparkLine } from '@/components/charts/spark-line';
import type { MetricSparklines } from '@/lib/data/events';

interface MetricCardProps {
  label: string;
  value: number | string;
  sublabel?: string;
  icon: React.ReactNode;
  href?: string;
  accent?: 'success' | 'warning' | 'destructive';
  sparkline?: number[];
  sparklineColor?: string;
}

function MetricCard({ label, value, sublabel, icon, href, accent, sparkline, sparklineColor }: MetricCardProps) {
  const router = useRouter();
  return (
    <div
      className={cn(
        "hud-panel rounded-xl border bg-card p-4 transition-all hover:shadow-md",
        href && "cursor-pointer hover:border-primary/40",
        accent === 'success' && "border-success/20 bg-success/5",
        accent === 'warning' && "border-warning/20 bg-warning/5",
        accent === 'destructive' && "border-destructive/20 bg-destructive/5",
      )}
      onClick={href ? () => router.push(href) : undefined}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </p>
          <p
            key={String(value)}
            className={cn(
              "mt-1 text-3xl font-bold tabular-nums font-mono animate-value-in",
              accent === 'success' && "text-success",
              accent === 'warning' && "text-warning",
              accent === 'destructive' && "text-destructive",
            )}
          >
            {value}
          </p>
          {sublabel && (
            <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
          )}
          {sparkline && sparkline.some(v => v > 0) && (
            <div className="mt-2 opacity-60">
              <SparkLine
                data={sparkline}
                color={sparklineColor ?? 'currentColor'}
                width={80}
                height={22}
              />
            </div>
          )}
        </div>
        <div className={cn(
          "ml-3 rounded-lg p-2.5 shrink-0",
          accent === 'success' ? "bg-success/15" : accent === 'warning' ? "bg-warning/15" : accent === 'destructive' ? "bg-destructive/15" : "bg-muted/50",
        )}>{icon}</div>
      </div>
    </div>
  );
}

interface MetricCardsProps {
  agentsOnline: number;
  agentsTotal: number;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksPending: number;
  pendingApprovals: number;
  blockedTasks: number;
  sparklines?: MetricSparklines;
}

export function MetricCards({
  agentsOnline,
  agentsTotal,
  tasksCompleted,
  tasksInProgress,
  tasksPending,
  pendingApprovals,
  blockedTasks,
  sparklines,
}: MetricCardsProps) {
  const allOnline = agentsOnline === agentsTotal && agentsTotal > 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <MetricCard
        label="Agents Online"
        value={`${agentsOnline}/${agentsTotal}`}
        sublabel={allOnline ? 'All systems go' : `${agentsTotal - agentsOnline} offline`}
        icon={<IconRobot size={20} className={allOnline ? "text-success" : "text-warning"} />}
        href="/agents"
        accent={allOnline ? 'success' : 'warning'}
        sparkline={sparklines?.heartbeats}
        sparklineColor="hsl(var(--success))"
      />
      <MetricCard
        label="Completed Today"
        value={tasksCompleted}
        sublabel={`${tasksInProgress} active, ${tasksPending} queued`}
        icon={<IconChecklist size={20} className="text-primary" />}
        href="/tasks"
        sparkline={sparklines?.tasksCompleted}
        sparklineColor="hsl(var(--primary))"
      />
      <MetricCard
        label="Approvals"
        value={pendingApprovals}
        sublabel={pendingApprovals === 0 ? 'Queue clear' : 'Awaiting review'}
        icon={<IconShieldCheck size={20} className={pendingApprovals > 0 ? "text-warning" : "text-muted-foreground"} />}
        href="/approvals"
        accent={pendingApprovals > 0 ? 'warning' : undefined}
        sparkline={sparklines?.approvals}
        sparklineColor="hsl(var(--warning))"
      />
      <MetricCard
        label="Blocked"
        value={blockedTasks}
        sublabel={blockedTasks === 0 ? 'No blockers' : 'Needs attention'}
        icon={<IconAlertTriangle size={20} className={blockedTasks > 0 ? "text-destructive" : "text-muted-foreground"} />}
        href="/tasks?status=blocked"
        accent={blockedTasks > 0 ? 'destructive' : undefined}
        sparkline={sparklines?.blocked}
        sparklineColor="hsl(var(--destructive))"
      />
    </div>
  );
}
