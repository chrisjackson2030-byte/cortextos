'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { RuntimeBadge } from '@/components/shared/runtime-badge';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { AgentActions } from './agent-actions';
import { IconChecklist, IconClock } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { AgentRuntime, HealthStatus } from '@/lib/types';

export interface AgentCardData {
  name: string;
  /** Filesystem / config key (e.g. "devbot"). Used for URL routing. */
  systemName: string;
  org: string;
  emoji: string;
  role: string;
  health: HealthStatus;
  currentTask?: string;
  taskUpdatedAt?: string;
  tasksToday: number;
  runtime?: AgentRuntime;
}

interface AgentCardProps {
  agent: AgentCardData;
}

function formatDuration(isoTimestamp: string): string {
  const elapsed = Date.now() - new Date(isoTimestamp).getTime();
  const totalMin = Math.floor(elapsed / 60000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function AgentCard({ agent }: AgentCardProps) {
  const router = useRouter();

  const healthLabel =
    agent.health === 'healthy' ? 'Online' :
    agent.health === 'stale' ? 'Stale' : 'Offline';

  return (
    <Link href={`/agents/${encodeURIComponent(agent.systemName)}/chat`}>
      <Card className={cn(
        "group relative h-full cursor-pointer transition-all hover:shadow-md",
        agent.health === 'healthy' && "agent-card-healthy border-success/35",
        agent.health === 'stale' && "agent-card-stale border-warning/35",
        agent.health === 'down' && "border-destructive/25",
      )}>
        <CardContent className="space-y-3">
          {/* Header: avatar + name + health */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <AgentAvatar name={agent.name} emoji={agent.emoji} systemName={agent.systemName} size="md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold leading-tight">{agent.name}</p>
                  <HealthDot status={agent.health} />
                </div>
                {agent.systemName && agent.systemName !== agent.name && (
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {agent.systemName}
                  </p>
                )}
                {agent.role && (
                  <p className="text-[11px] text-muted-foreground truncate max-w-[180px] mt-0.5">
                    {agent.role}
                  </p>
                )}
              </div>
            </div>
            <AgentActions
              agentName={agent.systemName}
              org={agent.org}
              health={agent.health}
              onAction={() => router.refresh()}
            />
          </div>

          {/* Org + runtime badges */}
          <div className="flex items-center gap-1.5">
            {agent.org && <OrgBadge org={agent.org} />}
            {agent.runtime && <RuntimeBadge runtime={agent.runtime} />}
          </div>

          {/* Current task */}
          {agent.currentTask ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2">
              <div className="flex items-center justify-between mb-0.5">
                <p className="text-[11px] text-muted-foreground">Working on</p>
                {agent.taskUpdatedAt && (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-primary/70">
                    <IconClock size={10} />
                    {formatDuration(agent.taskUpdatedAt)}
                  </span>
                )}
              </div>
              <p className="text-xs leading-snug line-clamp-2">
                {agent.currentTask.replace(/^WORKING ON:\s*/i, '')}
              </p>
            </div>
          ) : (
            <div className="rounded-md bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">
                {agent.health === 'healthy' ? 'Idle' : healthLabel}
              </p>
            </div>
          )}

          {/* Footer: tasks count */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <IconChecklist size={13} />
            <span>
              {agent.tasksToday} task{agent.tasksToday !== 1 ? 's' : ''} today
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
