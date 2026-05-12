'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import {
  IconMessage,
  IconCheckbox,
  IconShield,
  IconAlertTriangle,
  IconFlag,
  IconActivity,
  IconPlayerPause,
  IconPlayerPlay,
  IconRobot,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeAgo } from '@/components/shared/time-ago';
import { useSSE } from '@/hooks/use-sse';
import { displayAgentName } from '@/lib/utils';
import type { Event, SSEEvent } from '@/lib/types';

interface LiveActivityProps {
  initialEvents: Event[];
}

const EVENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  message: <IconMessage size={14} />,
  task: <IconCheckbox size={14} />,
  approval: <IconShield size={14} />,
  error: <IconAlertTriangle size={14} className="text-destructive" />,
  milestone: <IconFlag size={14} className="text-primary" />,
  heartbeat: <IconActivity size={14} className="text-muted-foreground/50" />,
};

const FILTER_TYPES = ['all', 'task', 'action', 'heartbeat', 'message'] as const;
type FilterType = typeof FILTER_TYPES[number];

interface DisplayEvent {
  id: string;
  timestamp: string;
  type: string;
  agent: string;
  message: string;
}

function sseToDisplayEvent(sse: SSEEvent, index: number): DisplayEvent {
  return {
    id: `sse-${sse.timestamp}-${index}`,
    timestamp: sse.timestamp,
    type: sse.type ?? 'event',
    agent: (sse.data?.agent as string) ?? '',
    message: (sse.data?.message as string) ?? sse.type ?? 'Event',
  };
}

function eventToDisplayEvent(event: Event): DisplayEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    agent: event.agent,
    message: event.message ?? event.category ?? event.type,
  };
}

function matchesTypeFilter(event: DisplayEvent, filter: FilterType): boolean {
  if (filter === 'all') return true;
  return event.type === filter;
}

export function LiveActivity({ initialEvents }: LiveActivityProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [liveEvents, setLiveEvents] = useState<DisplayEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const { events: sseEvents, isConnected } = useSSE({ bufferSize: 20 });

  useEffect(() => {
    if (sseEvents.length > 0) {
      setLiveEvents(sseEvents.map(sseToDisplayEvent));
    }
  }, [sseEvents]);

  // Combine, dedupe, sort
  const allEvents = useMemo(() => {
    const combined = [...liveEvents, ...initialEvents.map(eventToDisplayEvent)];
    const seen = new Set<string>();
    return combined
      .filter((e) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 50);
  }, [liveEvents, initialEvents]);

  // Unique agents (excluding empty)
  const uniqueAgents = useMemo(
    () => ['all', ...Array.from(new Set(allEvents.map((e) => e.agent).filter(Boolean)))],
    [allEvents]
  );

  // Apply filters, then limit to 20
  const displayEvents = useMemo(
    () =>
      allEvents
        .filter((e) => matchesTypeFilter(e, typeFilter))
        .filter((e) => agentFilter === 'all' || e.agent === agentFilter)
        .slice(0, 20),
    [allEvents, typeFilter, agentFilter]
  );

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [displayEvents.length, paused]);

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Live Activity
            </span>
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isConnected ? 'bg-success animate-pulse' : 'bg-warning'
              }`}
              title={isConnected ? 'Connected' : 'Reconnecting...'}
            />
          </div>
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            className="rounded-md p-1 hover:bg-muted transition-colors"
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? (
              <IconPlayerPlay size={16} className="text-muted-foreground" />
            ) : (
              <IconPlayerPause size={16} className="text-muted-foreground" />
            )}
          </button>
        </CardTitle>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1 pt-1">
          {FILTER_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors capitalize ${
                typeFilter === t
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Agent filter — only show when multiple agents exist */}
        {uniqueAgents.length > 2 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            <IconRobot size={11} className="mt-0.5 text-muted-foreground/60 shrink-0" />
            {uniqueAgents.map((agent) => (
              <button
                key={agent}
                type="button"
                onClick={() => setAgentFilter(agent)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-mono transition-colors ${
                  agentFilter === agent
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {agent === 'all' ? 'all agents' : displayAgentName(agent)}
              </button>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent className="flex-1 min-h-0 pt-0">
        <div ref={scrollRef} className="max-h-[360px] overflow-y-auto space-y-0.5">
          {displayEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {typeFilter !== 'all' || agentFilter !== 'all'
                ? 'No events match the current filter.'
                : 'Your agents are starting up. Activity will appear here.'}
            </p>
          ) : (
            displayEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/50 text-sm"
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  {EVENT_TYPE_ICONS[event.type] ?? <IconActivity size={14} />}
                </span>
                {event.agent && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium">
                    {displayAgentName(event.agent)}
                  </span>
                )}
                <span className="truncate flex-1 text-xs">{event.message}</span>
                <TimeAgo date={event.timestamp} className="shrink-0 text-[10px] font-mono text-muted-foreground" />
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
