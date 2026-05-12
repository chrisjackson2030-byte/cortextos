import {
  IconActivity,
  IconAlertTriangle,
  IconBolt,
  IconCheckbox,
  IconClock,
  IconFlag,
  IconHeartbeat,
  IconListCheck,
  IconMessage,
  IconShield,
} from '@tabler/icons-react';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SparkLine } from '@/components/charts/spark-line';
import { getAgentDetail } from '@/lib/data/agents';
import { getAgentRuntime } from '@/lib/agent-runtime';
import { getEventsByAgent, getAgentHeartbeatSparkline } from '@/lib/data/events';
import { getTasksByAgent } from '@/lib/data/tasks';
import type { Event } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: string): string {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return 'unknown';
  }
}

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
      <span className="shrink-0 font-mono text-xs text-muted-foreground" suppressHydrationWarning>
        {formatTime(event.timestamp)}
      </span>
    </div>
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

  // Events — last 8 for this agent
  const recentEvents = getEventsByAgent(decoded, 8);

  // Tasks
  const agentTasks = getTasksByAgent(decoded, runtime.org);

  // Heartbeat sparkline — 24 hourly buckets
  const hbSparkline = getAgentHeartbeatSparkline(decoded);

  // Task stats
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const inProgressCount = agentTasks.filter((t) => t.status === 'in_progress').length;
  const completedToday  = agentTasks.filter((t) => t.completed_at && t.completed_at >= todayISO).length;
  const pendingCount    = agentTasks.filter((t) => t.status === 'pending').length;

  const currentTask =
    agentTasks.find((t) => t.status === 'in_progress')?.title ??
    detail?.heartbeat?.current_task ??
    null;

  const lastHeartbeat = detail?.heartbeat?.last_heartbeat ?? null;
  const hbSum = hbSparkline.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      {/* Current task */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <IconBolt size={14} />
            Current Task
          </CardTitle>
        </CardHeader>
        <CardContent>
          {currentTask ? (
            <p className="text-sm font-medium leading-snug">{currentTask}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">No active task</p>
          )}
          {lastHeartbeat && (
            <p className="mt-1 font-mono text-xs text-muted-foreground" suppressHydrationWarning>
              Last heartbeat {formatTime(lastHeartbeat)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Task stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                <IconListCheck size={12} />
                In Progress
              </span>
              <span className="font-mono text-2xl font-semibold">{inProgressCount}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                <IconCheckbox size={12} />
                Done Today
              </span>
              <span className="font-mono text-2xl font-semibold">{completedToday}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                <IconClock size={12} />
                Pending
              </span>
              <span className="font-mono text-2xl font-semibold">{pendingCount}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Heartbeat sparkline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <span className="flex items-center gap-2">
              <IconHeartbeat size={14} />
              Heartbeat — last 24h
            </span>
            <span className="font-mono text-xs normal-case">
              {hbSum} event{hbSum !== 1 ? 's' : ''}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SparkLine data={hbSparkline} width="100%" height={40} />
        </CardContent>
      </Card>

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
