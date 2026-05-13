import { getHealthSummary } from '@/lib/data/heartbeats';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const summary = await getHealthSummary();
    return Response.json({
      healthy: summary.healthy,
      stale: summary.stale,
      down: summary.down,
      total: summary.healthy + summary.stale + summary.down,
    });
  } catch {
    return Response.json({ healthy: 0, stale: 0, down: 0, total: 0 }, { status: 500 });
  }
}
