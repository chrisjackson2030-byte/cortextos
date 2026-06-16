import Link from 'next/link';
import { getOrgs } from '@/lib/config';
import { getPendingCount } from '@/lib/data/approvals';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getGoals } from '@/lib/data/goals';
import { getHealthSummary, getAllHeartbeats } from '@/lib/data/heartbeats';
import { getRecentEvents } from '@/lib/data/events';
import { discoverAgents } from '@/lib/data/agents';

import { TradingSnapshot } from '@/components/overview/trading-snapshot';
import { ActionRequired } from '@/components/overview/action-required';
import { LiveActivity } from '@/components/overview/live-activity';
import { AgentStatusGrid } from '@/components/overview/agent-status-grid';
import { ActiveWork } from '@/components/overview/active-work';
import { AutoRefresh } from '@/components/overview/auto-refresh';
import { DailyFocusBanner } from '@/components/overview/daily-focus-banner';

export const dynamic = 'force-dynamic';

// 2026-06-10 overhaul: slimmed from 13 stacked panels to ~5. The screen answers
// three questions: Does anything need me? Is money OK? Is the fleet OK?
// Cut: BuildTracker + JarvisBuildPanel (anchored to the superseded Jun-3 plan),
// DebriefMemory, ActivityHeatmap, AgentTaskBreakdown, CurrentFocus,
// TodaysProgress, MetricCards sparklines (headline numbers fold into the thin
// strip below the header), SystemHealth (AgentStatusGrid covers the fleet).

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
    agents,
    heartbeatsList,
  ] = await Promise.all([
    Promise.resolve(getPendingCount(org || undefined)),
    Promise.resolve(getTasks({ status: 'blocked', org: org || undefined })),
    Promise.resolve(getTasks({ org: org || undefined })),
    Promise.resolve(getGoals(org || 'default')),
    getHealthSummary(org || undefined),
    Promise.resolve(getTasksCompletedToday(org || undefined)),
    Promise.resolve(getRecentEvents(20, org || undefined)),
    discoverAgents(org || undefined),
    getAllHeartbeats(),
  ]);

  // Convert heartbeats array to lookup map
  const heartbeats: Record<string, typeof heartbeatsList[number]> = {};
  for (const hb of heartbeatsList) {
    heartbeats[hb.agent] = hb;
  }

  // Filter stub/inactive agents from fleet display
  const visibleAgents = agents.filter(a => !a.name.startsWith('_'));

  const staleAgentCount = healthSummary.agents
    .filter(a => !a.agent.startsWith('_'))
    .filter(a => a.health === 'stale' || a.health === 'down')
    .length;
  const inProgressTaskList = allTasks.filter(t => t.status === 'in_progress');
  const inProgressTasks = inProgressTaskList.length;
  const pendingTasks = allTasks.filter(t => t.status === 'pending').length;
  const humanTasks = allTasks.filter(t => t.assignee === 'human' && t.status !== 'completed').length;
  const totalActions = pendingCount + blockedTasks.length + staleAgentCount + humanTasks;

  // Headline numbers as a thin strip (replaces the MetricCards sparkline grid)
  const strip: { label: string; value: string; href: string; alert?: boolean }[] = [
    {
      label: 'agents online',
      value: `${healthSummary.healthy}/${healthSummary.healthy + healthSummary.stale + healthSummary.down}`,
      href: '/agents',
      alert: staleAgentCount > 0,
    },
    { label: 'done today', value: String(completedToday.length), href: '/tasks?status=completed' },
    { label: 'in progress', value: String(inProgressTasks), href: '/tasks?status=in_progress' },
    { label: 'pending', value: String(pendingTasks), href: '/tasks?status=pending' },
    { label: 'approvals', value: String(pendingCount), href: '/approvals', alert: pendingCount > 0 },
    { label: 'blocked', value: String(blockedTasks.length), href: '/tasks?status=blocked', alert: blockedTasks.length > 0 },
  ];

  return (
    <div className="space-y-6">
      {/* Auto-refresh every 30s */}
      <AutoRefresh intervalMs={30000} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight dark:text-foreground">
              <span className="dark:text-primary dark:drop-shadow-[0_0_8px_oklch(0.72_0.18_210/0.6)]">⬡</span>
              {' '}Command Center
            </h1>
            <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-success border border-success/20 dark:arc-pulse dark:shadow-[0_0_6px_oklch(0.65_0.19_160/0.4)]">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              LIVE
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
            {healthSummary.healthy}/{healthSummary.healthy + healthSummary.stale + healthSummary.down} agents online
            {inProgressTasks > 0 && ` · ${inProgressTasks} active`}
            {org ? ` · ${org}` : ''}
          </p>
        </div>
        {totalActions > 0 && (
          <Link
            href={pendingCount > 0 ? '/approvals' : staleAgentCount > 0 ? '/agents' : blockedTasks.length > 0 ? '/tasks?status=blocked' : '/tasks?agent=human'}
            className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors cursor-pointer border border-destructive/20"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
            {totalActions} action{totalActions !== 1 ? 's' : ''} needed
          </Link>
        )}
      </div>

      {/* Headline numbers — thin strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border bg-card/50 px-4 py-2 font-mono text-xs">
        {strip.map((m) => (
          <Link key={m.label} href={m.href} className="flex items-baseline gap-1.5 hover:text-foreground transition-colors">
            <span className={`text-base font-bold tabular-nums ${m.alert ? 'text-warning' : 'text-foreground'}`}>
              {m.value}
            </span>
            <span className="text-muted-foreground uppercase tracking-wider text-[10px]">{m.label}</span>
          </Link>
        ))}
      </div>

      {/* Action Required — always visible, even when 0 ("all clear" state) */}
      <ActionRequired
        pendingApprovals={pendingCount}
        blockedTasks={blockedTasks.length}
        staleAgents={staleAgentCount}
        humanTasks={humanTasks}
      />

      {/* Daily Focus + Bottleneck (TimeAgo chip makes staleness visible) */}
      <DailyFocusBanner
        dailyFocus={goalsData.daily_focus}
        dailyFocusSetAt={goalsData.daily_focus_set_at}
        bottleneck={goalsData.bottleneck}
      />

      {/* Profit Pulse — live trading (prediction markets + Alpaca options w/ live account) */}
      <TradingSnapshot />

      {/* Active Work — in progress + recently completed */}
      <ActiveWork
        inProgressTasks={inProgressTaskList}
        recentlyCompleted={completedToday}
      />

      {/* Agent Status Grid + Live Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1">
          <AgentStatusGrid agents={visibleAgents} heartbeats={heartbeats} />
        </div>
        <div className="xl:col-span-2">
          <LiveActivity initialEvents={recentEvents} />
        </div>
      </div>
    </div>
  );
}
