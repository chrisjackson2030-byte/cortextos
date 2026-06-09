import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Ideas & Decisions board (B 2026-06-04). Surfaces (1) decisions waiting on B that
// would otherwise fall through the cracks, and (2) B's filed-but-not-executed ideas.
// Source: jarvis/state/ideas-decisions.json (Jarvis appends decisions when it asks B
// something + ideas when B surfaces one; clears decisions when answered).

const HOME = process.env.HOME ?? '/Users/chrisjackson';
const FILE = path.join(HOME, 'cortextos/orgs/main/agents/jarvis/state/ideas-decisions.json');

export async function GET(_req: NextRequest) {
  let data: { decisions?: any[]; ideas?: any[] } = {};
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return Response.json({ available: false, reason: 'ideas-decisions store not found' });
  }
  const openDecisions = (data.decisions ?? []).filter((d) => d.status === 'open');
  const answered = (data.decisions ?? []).filter((d) => d.status !== 'open');
  const now = Date.now();
  const withAge = openDecisions.map((d) => ({
    ...d,
    age_hours: d.asked_at ? Math.round((now - Date.parse(d.asked_at)) / 3.6e6) : null,
  }));

  return Response.json({
    available: true,
    summary: {
      open_decisions: openDecisions.length,
      ideas_count: (data.ideas ?? []).length,
      answered_count: answered.length,
    },
    decisions: withAge,
    ideas: data.ideas ?? [],
  });
}
