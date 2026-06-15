import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { auth } from '@/lib/auth';
import { getPendingApprovals } from '@/lib/data/approvals';
import { getTasksCompletedToday } from '@/lib/data/tasks';
import {
  approvalToInboxItem,
  getOpenDecisions,
  getOpenQuestions,
  type InboxItem,
} from '@/lib/data/inbox';

export const dynamic = 'force-dynamic';

const ORG_ROOT = path.join(os.homedir(), 'cortextos/orgs/main');
const HB_ROOT = path.join(os.homedir(), '.cortextos/default/state');

function readSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

interface FleetAgent {
  name: string;
  status: string;
  minutesAgo: number;
  task: string;
}

interface PendingItem {
  title: string;
  detail: string;
  source: string; // 'approval' | 'decision' | 'open-question'
  ageDays: number | null;
}

interface StatusData {
  /** tasks completed today (bus state, live) — replaces the dead memory-line parser */
  completedToday: { count: number; titles: string[] };
  /** things actually waiting on B: pending approvals + open decisions + open questions */
  pendingItems: PendingItem[];
  fleet: FleetAgent[];
  focus: string;
  focusSetAt: string | null;
  focusAgeHours: number | null;
  northStar: string;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result: StatusData = {
    completedToday: { count: 0, titles: [] },
    pendingItems: [],
    fleet: [],
    focus: '',
    focusSetAt: null,
    focusAgeHours: null,
    northStar: '',
  };

  const goals = readSafe(path.join(ORG_ROOT, 'goals.json'));
  if (goals) {
    try {
      const g = JSON.parse(goals);
      result.focus = g.daily_focus || '';
      result.northStar = g.north_star_vehicle || g.north_star || '';
      if (g.daily_focus_set_at) {
        result.focusSetAt = g.daily_focus_set_at;
        const t = Date.parse(g.daily_focus_set_at);
        if (!isNaN(t)) result.focusAgeHours = Math.round((Date.now() - t) / 3.6e6);
      }
    } catch { /* skip */ }
  }

  // Tasks completed today from bus state (live) — the old daily-memory line
  // parser matched a format that drifted and always yielded zero rows.
  try {
    const completed = getTasksCompletedToday();
    result.completedToday = {
      count: completed.length,
      titles: completed.slice(0, 5).map((t) => t.title),
    };
  } catch { /* skip — panel degrades to 0 */ }

  // AWAITING YOUR INPUT — live sources. The previous source,
  // state/pending-b-decisions.md, was abandoned Jun 3 (queue "(empty)") so the
  // panel permanently said "No pending items" while real asks piled up elsewhere.
  const toPending = (i: InboxItem): PendingItem => ({
    title: i.title,
    detail: i.detail,
    source: i.source,
    ageDays: i.ageDays,
  });
  try {
    result.pendingItems.push(
      ...getPendingApprovals().slice(0, 5).map(approvalToInboxItem).map(toPending),
    );
  } catch { /* skip */ }
  result.pendingItems.push(...getOpenDecisions().map(toPending));
  result.pendingItems.push(...getOpenQuestions().map(toPending));
  result.pendingItems = result.pendingItems.slice(0, 10);

  const agents = ['jarvis', 'forge', 'nova', 'friday'];
  for (const agent of agents) {
    const hb = readSafe(path.join(HB_ROOT, `${agent}/heartbeat.json`));
    if (hb) {
      try {
        const h = JSON.parse(hb);
        const ts = h.last_heartbeat || h.last_seen;
        const ago = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 60000) : -1;
        result.fleet.push({
          name: h.display_name || agent,
          status: ago > 300 ? 'STALE' : 'ONLINE',
          minutesAgo: ago,
          task: h.status || '',
        });
      } catch { /* skip */ }
    }
  }

  return NextResponse.json(result);
}
