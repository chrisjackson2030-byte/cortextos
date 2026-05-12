import { discoverAgents } from '@/lib/data/agents';
import { AgentsGrid } from '@/components/agents/agents-grid';
import type { AgentCardData } from '@/components/agents/agent-card';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgFilter = typeof params.org === 'string' ? params.org : undefined;

  const raw = await discoverAgents(orgFilter);

  const agents: AgentCardData[] = raw.map((a) => {
    const extra = a as unknown as Record<string, unknown>;
    return {
      name: a.name,
      systemName: (extra.systemName as string) ?? a.name,
      org: a.org,
      emoji: (extra.emoji as string) ?? '',
      role: (extra.role as string) ?? '',
      health: a.health,
      currentTask: a.currentTask,
      taskUpdatedAt: (extra.taskUpdatedAt as string) ?? undefined,
      tasksToday: (extra.tasksToday as number) ?? 0,
      runtime: a.runtime,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {orgFilter ? `Org: ${orgFilter}` : 'All organizations'} - {agents.length} agent
          {agents.length !== 1 ? 's' : ''}
        </p>
      </div>

      <AgentsGrid initialAgents={agents} />
    </div>
  );
}
