import Link from 'next/link';
import { getOrgs } from '@/lib/config';
import { getPendingCount } from '@/lib/data/approvals';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getGoals } from '@/lib/data/goals';
import { getHealthSummary, getAllHeartbeats } from '@/lib/data/heartbeats';
import { getRecentEvents, getMilestones, getMetricSparklines, getActivityHeatmap } from '@/lib/data/events';
import { discoverAgents } from '@/lib/data/agents';

import { ActionRequired } from '@/components/overview/action-required';
import { CurrentFocus } from '@/components/overview/current-focus';
import { TodaysProgress } from '@/components/overview/todays-progress';
import { LiveActivity } from '@/components/overview/live-activity';
import { SystemHealth } from '@/components/overview/system-health';
import { MetricCards } from '@/components/overview/metric-cards';
import { AgentStatusGrid } from '@/components/overview/agent-status-grid';
import { ActiveWork } from '@/components/overview/active-work';
import { AgentTaskBreakdown } from '@/components/overview/agent-task-breakdown';
import { AutoRefresh } from '@/components/overview/auto-refresh';
import { DailyFocusBanner } from '@/components/overview/daily-focus-banner';
import { ActivityHeatmap } from '@/components/overview/activity-heatmap';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  // Default to empty string (all orgs) instead of first org, so all agents show
  const org = orgParam && orgs.includes(orgParam) ? orgParam : '';

  // Fetch all data in parallel
  const [
    pendingCount,
    blockedTasks,
    allTasks,
    goalsData,
    healthSummary,
    completedToday,
    recentEvents,
    milestones,
    agents,
    heartbeatsList,
    sparklines,
    heatmapData,
  ] = await Promise.all([
    Promise.resolve(getPendingCount(org || undefined)),
    Promise.resolve(getTasks({ status: 'blocked', org: org || undefined })),
    Promise.resolve(getTasks({ org: org || undefined })),
    Promise.resolve(getGoals(org || 'default')),
    getHealthSummary(org || undefined),
    Promise.resolve(getTasksCompletedToday(org || undefined)),
    Promise.resolve(getRecentEvents(20, org || undefined)),
    Promise.resolve(getMilestones(org || undefined)),
    discoverAgents(org || undefined),
    getAllHeartbeats(),
    Promise.resolve(getMetricSparklines(org || undefined)),
    Promise.resolve(getActivityHeatmap(org || undefined)),
  ]);

  // Convert heartbeats array to lookup map
  const heartbeats: Record<string, typeof heartbeatsList[number]> = {};
  for (const hb of heartbeatsList) {
    heartbeats[hb.agent] = hb;
  }

  // Filter stub/inactive agents from fleet display
  const visibleAgents = agents.filter(a => !a.name.startsWith('_'));

  const staleAgentCount = healthSummary.stale + healthSummary.down;
  const inProgressTaskList = allTasks.filter(t => t.status === 'in_progress');
  const inProgressTasks = inProgressTaskList.length;
  const pendingTasks = allTasks.filter(t => t.status === 'pending').length;
  const humanTasks = allTasks.filter(t => t.assignee === 'human' && t.status !== 'completed').length;
  const totalActions = pendingCount + blockedTasks.length + staleAgentCount + humanTasks;

  return (
    <div className="space-y-6">
      {/* Auto-refresh every 30s */}
      <AutoRefresh intervalMs={30000} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Command Center</h1>
            <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success border border-success/20">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              LIVE
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {healthSummary.healthy} agent{healthSummary.healthy !== 1 ? 's' : ''} online
            {inProgressTasks > 0 && ` · ${inProgressTasks} task${inProgressTasks !== 1 ? 's' : ''} in progress`}
            {org ? ` · ${org}` : ''}
          </p>
        </div>
        {totalActions > 0 && (
          <Link
            href="/approvals"
            className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer border border-destructive/20"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
            {totalActions} action{totalActions !== 1 ? 's' : ''} needed
          </Link>
        )}
      </div>

      {/* Daily Focus + Bottleneck */}
      <DailyFocusBanner
        dailyFocus={goalsData.daily_focus}
        dailyFocusSetAt={goalsData.daily_focus_set_at}
        bottleneck={goalsData.bottleneck}
      />

      {/* Metric Cards */}
      <MetricCards
        agentsOnline={healthSummary.healthy}
        agentsTotal={healthSummary.healthy + healthSummary.stale + healthSummary.down}
        tasksCompleted={completedToday.length}
        tasksInProgress={inProgressTasks}
        tasksPending={pendingTasks}
        pendingApprovals={pendingCount}
        blockedTasks={blockedTasks.length}
        sparklines={sparklines}
      />

      {/* Active Work — in progress + recently completed */}
      <ActiveWork
        inProgressTasks={inProgressTaskList}
        recentlyCompleted={completedToday}
      />

      {/* Action Required - only show if there are actions */}
      {totalActions > 0 && (
        <ActionRequired
          pendingApprovals={pendingCount}
          blockedTasks={blockedTasks.length}
          staleAgents={staleAgentCount}
          humanTasks={humanTasks}
        />
      )}

      {/* Agent Status Grid + Live Activity + Heatmap */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 space-y-4">
          <AgentStatusGrid agents={visibleAgents} heartbeats={heartbeats} />
          <AgentTaskBreakdown tasks={allTasks} />
          <ActivityHeatmap data={heatmapData} />
        </div>
        <div className="xl:col-span-2">
          <LiveActivity initialEvents={recentEvents} />
        </div>
      </div>

      {/* Current Focus + Today's Progress */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <CurrentFocus
            org={org || 'default'}
            bottleneck={goalsData.bottleneck}
            goals={goalsData.goals}
          />
        </div>
        <div className="lg:col-span-2">
          <TodaysProgress
            completedTasks={completedToday}
            milestones={milestones}
          />
        </div>
      </div>

      {/* System Health */}
      <SystemHealth summary={healthSummary} />
    </div>
  );
}
