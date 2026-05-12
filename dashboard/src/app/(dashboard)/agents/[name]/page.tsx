import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconCheckbox,
  IconCircleCheck,
  IconClock,
  IconFlag,
  IconHeartbeat,
  IconLoader2,
  IconMessage,
  IconShield,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SparkLine } from '@/components/charts/spark-line';
import { TimeAgo } from '@/components/shared/time-ago';
import { getAgentDetail } from '@/lib/data/agents';
import { getAgentRuntime } from '@/lib/agent-runtime';
import { getEventsByAgent, getAgentHeartbeatSparkline } from '@/lib/data/events';
import { getTasksByAgent } from '@/lib/data/tasks';
import type { Event, Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const eventTypeIcons: Record<string, React.ReactNode> = {
  message:   <IconMessage size={13} className="shrink-0" />,
  task:      <IconCheckbox size={13} className="shrink-0" />,
  approval:  <IconShield size={13} className="shrink-0" />,
  error:     <IconAlertTriangle size={13} className="shrink-0 text-destructive" />,
  milestone: <IconFlag size={13} className="shrink-0 text-primary" />,
  heartbeat: <IconHeartbeat size={13} className="shrink-0" />,
  action:    <IconBolt size={13} className="shrink-0" />,
};

function EventRow({ event }: { event: Event }) {
  const icon = eventTypeIcons[event.type] ?? <IconActivity size={13} className="shrink-0" />;
  const label = event.message ?? event.category ?? event.type;
  return (
    <div className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/50 text-sm">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="truncate flex-1 text-foreground">{label}</span>
      <TimeAgo date={event.timestamp} className="shrink-0 font-mono text-xs text-muted-foreground" />
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const isActive = task.status === 'in_progress';
  const isDone = task.status === 'completed';
  return (
    <Link
      href={`/tasks?status=${task.status}`}
      className="flex items-start gap-2.5 rounded px-2 py-2 hover:bg-muted/40 transition-colors"
    >
      {isActive ? (
        <IconLoader2 size={13} className="mt-0.5 shrink-0 text-primary animate-spin" style={{ animationDuration: '3s' }} />
      ) : isDone ? (
        <IconCircleCheck size={13} className="mt-0.5 shrink-0 text-success" />
      ) : (
        <IconClock size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 truncate text-sm">{task.title}</span>
      {task.updated_at && (
        <TimeAgo date={task.updated_at} className="shrink-0 font-mono text-[10px] text-muted-foreground" />
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  // Runtime + detail (layout already fetched these, but page is independent)
  const runtime = await getAgentRuntime(decoded);
  const detail = await getAgentDetail(decoded, runtime.org).catch(() => null);

  // Events — last 10 for this agent
  const recentEvents = getEventsByAgent(decoded, 10);

  // Tasks
  const agentTasks = getTasksByAgent(decoded, runtime.org);

  // Heartbeat sparkline — 24 hourly buckets
  const hbSparkline = getAgentHeartbeatSparkline(decoded);

  // Task breakdown
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const inProgressTasks = agentTasks.filter((t) => t.status === 'in_progress');
  const completedToday  = agentTasks.filter((t) => t.completed_at && t.completed_at >= todayISO);
  const pendingTasks    = agentTasks.filter((t) => t.status === 'pending').slice(0, 5);

  const lastHeartbeat = detail?.heartbeat?.last_heartbeat ?? null;
  const hbSum = hbSparkline.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      {/* Active tasks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <span className="flex items-center gap-2">
              <IconBolt size={14} />
              Active
            </span>
            {lastHeartbeat && (
              <span className="flex items-center gap-1 normal-case font-normal">
                <span className="text-xs text-muted-foreground">heartbeat</span>
                <TimeAgo date={lastHeartbeat} className="font-mono text-xs text-muted-foreground" />
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          {inProgressTasks.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground italic">No active tasks</p>
          ) : (
            <div className="space-y-0.5">
              {inProgressTasks.map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Heartbeat sparkline + task stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm font-medium uppercase tracking-wider text-muted-foreground">
              <span className="flex items-center gap-2">
                <IconHeartbeat size={14} />
                Heartbeat — 24h
              </span>
              <span className="font-mono text-xs normal-case">{hbSum}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SparkLine data={hbSparkline} width="100%" height={36} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <IconLoader2 size={11} />
                Active
              </span>
              <span className="font-mono font-semibold">{inProgressTasks.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <IconCircleCheck size={11} />
                Done
              </span>
              <span className="font-mono font-semibold text-success">{completedToday.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <IconClock size={11} />
                Pending
              </span>
              <span className="font-mono font-semibold">{pendingTasks.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending tasks */}
      {pendingTasks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              <IconClock size={14} />
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            <div className="space-y-0.5">
              {pendingTasks.map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recently completed */}
      {completedToday.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              <IconCircleCheck size={14} />
              Done Today
              <span className="ml-auto font-mono text-xs normal-case font-normal">{completedToday.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            <div className="space-y-0.5">
              {completedToday.slice(0, 6).map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent events */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <IconActivity size={14} />
            Recent Events
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          {recentEvents.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground italic">No events recorded yet</p>
          ) : (
            <div className="space-y-0.5">
              {recentEvents.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
