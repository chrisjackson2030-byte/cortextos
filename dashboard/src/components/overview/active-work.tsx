'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  IconLoader2,
  IconCircleCheck,
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconUser,
  IconClock,
  IconNotes,
} from '@tabler/icons-react';
import { format } from 'date-fns';
import { TimeAgo } from '@/components/shared/time-ago';
import type { Task } from '@/lib/types';

interface ActiveWorkProps {
  inProgressTasks: Task[];
  recentlyCompleted: Task[];
}

function fmtDate(ts: string | undefined): string {
  if (!ts) return '';
  try {
    return format(new Date(ts), 'MMM d, h:mm a');
  } catch {
    return ts;
  }
}

function CompletedTaskRow({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors text-left group"
      >
        <IconCircleCheck size={15} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-sm truncate">{task.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{task.assignee ?? 'unassigned'}</span>
            {task.completed_at && (
              <TimeAgo date={task.completed_at} className="ml-2 opacity-60 font-mono text-xs text-muted-foreground" />
            )}
          </p>
        </div>
        {expanded ? (
          <IconChevronDown size={14} className="mt-0.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <IconChevronRight size={14} className="mt-0.5 shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 ml-8 space-y-2 border-t bg-muted/20">
          {task.description && (
            <p className="text-xs text-muted-foreground pt-2 leading-relaxed">{task.description}</p>
          )}
          <div className="flex flex-wrap gap-4 pt-1">
            {task.assignee && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconUser size={11} />
                {task.assignee}
              </span>
            )}
            {task.completed_at && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconCircleCheck size={11} className="text-success" />
                Completed {fmtDate(task.completed_at)}
              </span>
            )}
            {task.created_at && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconClock size={11} />
                Created {fmtDate(task.created_at)}
              </span>
            )}
          </div>
          {task.notes && (
            <div className="flex items-start gap-1 pt-1">
              <IconNotes size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground leading-relaxed">{task.notes}</p>
            </div>
          )}
          <Link
            href={`/tasks`}
            className="inline-block text-[10px] text-primary hover:underline mt-1"
          >
            View in tasks →
          </Link>
        </div>
      )}
    </div>
  );
}

export function ActiveWork({ inProgressTasks, recentlyCompleted }: ActiveWorkProps) {
  const hasActive = inProgressTasks.length > 0;
  const hasCompleted = recentlyCompleted.length > 0;

  if (!hasActive && !hasCompleted) return null;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Active work */}
      {hasActive && (
        <div className={hasCompleted ? 'border-b' : ''}>
          <div className="flex items-center gap-2 px-4 py-2.5 bg-primary/5 border-b border-primary/10">
            <IconBolt size={14} className="text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              Active Right Now
            </span>
            <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {inProgressTasks.length}
            </span>
          </div>
          <div className="divide-y">
            {inProgressTasks.map((task) => (
              <Link
                key={task.id}
                href={`/tasks?status=in_progress`}
                className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors group"
              >
                <IconLoader2
                  size={15}
                  className="mt-0.5 shrink-0 text-primary animate-spin"
                  style={{ animationDuration: '3s' }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                    {task.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    <span className="font-mono">{task.assignee ?? 'unassigned'}</span>
                    {task.updated_at && (
                      <TimeAgo date={task.updated_at} className="ml-2 opacity-60 font-mono text-xs text-muted-foreground" />
                    )}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary capitalize">
                  {task.priority}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recently completed */}
      {hasCompleted && (
        <div>
          <div className="flex items-center gap-2 px-4 py-2.5 bg-success/5 border-b border-success/10">
            <IconCircleCheck size={14} className="text-success" />
            <span className="text-xs font-semibold uppercase tracking-wider text-success">
              Recently Completed
            </span>
            <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
              {recentlyCompleted.length} today
            </span>
          </div>
          <div>
            {recentlyCompleted.slice(0, 8).map((task) => (
              <CompletedTaskRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
