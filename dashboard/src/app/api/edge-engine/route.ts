import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// Unified EDGE-ENGINE state (B 2026-06-08). READ-ONLY of the live feed Jarvis
// regenerates each edge-engine drive cycle + as verdicts change:
//   orgs/main/agents/jarvis/state/edge-engine-state.json
// ONE view across all 3 arenas (futures + crypto + prediction): per-arena data
// sources + row-counts + date-ranges, the REAL attempt count, the family verdict
// table (REJECT / VALIDATING + reason), the live lead, and the honest scoreboard.
// force-dynamic + generated_at surfaced => can never silently go stale like the old counts.
// No money, no execution — research/scoreboard only.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_PATH = path.join(
  getFrameworkRoot(),
  'orgs/main/agents/jarvis/state/edge-engine-state.json',
);

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest) {
  const state = readJson(STATE_PATH);
  if (!state) {
    return Response.json({
      available: false,
      reason: 'edge-engine-state.json not found or unreadable',
    });
  }
  return Response.json({ available: true, ...state });
}
