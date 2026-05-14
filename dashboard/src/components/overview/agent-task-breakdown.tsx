import Link from 'next/link';
import { IconLoader2, IconCircleCheck, IconClock, IconRobot } from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { displayAgentName } from '@/lib/utils';
import type { Task } from '@/lib/types';

interface AgentTaskBreakdownProps {
  tasks: Task[];
}

interface AgentStats {
  name: string;
  inProgress: number;
  completedToday: number;
  pending: number;
}

export function AgentTaskBreakdown({ tasks }: AgentTaskBreakdownProps) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Aggregate per agent
  const statsMap = new Map<string, AgentStats>();

  for (const task of tasks) {
    const agent = task.assignee ?? 'unassigned';
    if (!statsMap.has(agent)) {
      statsMap.set(agent, { name: agent, inProgress: 0, completedToday: 0, pending: 0 });
    }
    const s = statsMap.get(agent)!;
    if (task.status === 'in_progress') s.inProgress++;
    else if (task.status === 'pending') s.pending++;
    else if (
      task.status === 'completed' &&
      task.completed_at &&
      new Date(task.completed_at) >= todayStart
    ) {
      s.completedToday++;
    }
  }

  const stats = Array.from(statsMap.values())
    .filter((s) => s.inProgress > 0 || s.completedToday > 0 || s.pending > 0)
    .sort((a, b) => b.inProgress - a.inProgress || b.completedToday - a.completedToday);

  if (stats.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <IconRobot size={14} />
          Agent Workload
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1">
          {stats.map((s) => (
            <Link
              key={s.name}
              href={`/agents/${encodeURIComponent(s.name)}`}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors group"
            >
              <span className="w-20 shrink-0 text-sm font-medium font-mono truncate group-hover:text-primary transition-colors">
                {displayAgentName(s.name)}
              </span>
              <div className="flex flex-1 items-center gap-3 text-xs">
                {s.inProgress > 0 && (
                  <span className="flex items-center gap-1 text-primary font-mono">
                    <IconLoader2 size={12} className="animate-spin" style={{ animationDuration: '3s' }} />
                    {s.inProgress} active
                  </span>
                )}
                {s.completedToday > 0 && (
                  <span className="flex items-center gap-1 text-success font-mono">
                    <IconCircleCheck size={12} />
                    {s.completedToday} done
                  </span>
                )}
                {s.pending > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground font-mono">
                    <IconClock size={12} />
                    {s.pending} queued
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
