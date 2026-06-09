import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const JARVIS_ROOT = path.join(os.homedir(), 'cortextos/orgs/main/agents/jarvis');
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

interface StatusData {
  todayWork: string[];
  pendingQuestions: string[];
  fleet: FleetAgent[];
  focus: string;
  northStar: string;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const result: StatusData = {
    todayWork: [],
    pendingQuestions: [],
    fleet: [],
    focus: '',
    northStar: '',
  };

  const goals = readSafe(path.join(ORG_ROOT, 'goals.json'));
  if (goals) {
    try {
      const g = JSON.parse(goals);
      result.focus = g.daily_focus || '';
      result.northStar = g.north_star_vehicle || g.north_star || '';
    } catch { /* skip */ }
  }

  const memoryFile = readSafe(path.join(JARVIS_ROOT, `memory/${today}.md`));
  if (memoryFile) {
    const lines = memoryFile.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- COMPLETED:') || trimmed.startsWith('- Completed')) {
        result.todayWork.push(trimmed.replace(/^- (COMPLETED|Completed):?\s*/, ''));
      } else if (trimmed.startsWith('- WORKING ON:') || trimmed.startsWith('- Working')) {
        result.todayWork.push(trimmed.replace(/^- (WORKING ON|Working):?\s*/, '') + ' (in progress)');
      }
    }
  }

  const pendingFile = readSafe(path.join(JARVIS_ROOT, 'state/pending-b-decisions.md'));
  if (pendingFile) {
    const lines = pendingFile.split('\n');
    let inQueue = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '## Queue') { inQueue = true; continue; }
      if (trimmed.startsWith('## ') && inQueue) break;
      if (trimmed === '---' && inQueue) break;
      if (inQueue && trimmed.startsWith('- ') && trimmed.length > 3 && !trimmed.includes('**')) {
        result.pendingQuestions.push(trimmed.slice(2));
      }
    }
  }

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
