import { NextRequest } from 'next/server';
import { getPropFirmPayload } from '@/lib/data/prop-firm';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// /api/prop-firm — ONE live feed for the /prop-firm page (B 2026-06-15,
// "a dashboard for the prop firm stuff showing all the info regarding
// everything we are running"). Assembles, server-side on every request, the
// Topstep bot live status, the drawdown/survival view, the recent trade log,
// the 9-variant shadow-book leaderboard, and the recommended survival policy.
// READ-ONLY of bot files Jarvis already maintains: no execution, no money, no
// writes to any bot file. force-dynamic + generated_at => never silently stale.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    return Response.json({ available: true, ...getPropFirmPayload() });
  } catch (e) {
    return Response.json({ available: false, reason: String(e) });
  }
}
