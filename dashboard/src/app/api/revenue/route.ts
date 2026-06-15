import { NextRequest } from 'next/server';
import { getRevenuePayload } from '@/lib/data/revenue';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// /api/revenue — ONE live feed for the /revenue page (B 2026-06-12,
// "done right, updates on its own"). Assembles, server-side and on every
// request, the Revenue Director state (ledger/pending-B/leash), the Stage-2
// idea pipeline, the honest edge scoreboard, and last-known trading money
// state. READ-ONLY of files Jarvis already maintains; no execution, no money.
// force-dynamic + generated_at surfaced => can never silently go stale.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    return Response.json({ available: true, ...getRevenuePayload() });
  } catch (e) {
    return Response.json({ available: false, reason: String(e) });
  }
}
