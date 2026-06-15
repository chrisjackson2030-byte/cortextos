import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getNewIdeas, getThrowback } from '@/lib/data/command-center';

export const dynamic = 'force-dynamic';

// The "second brain" glance feed for B's main (voice) dashboard: the freshest
// captured ideas + the single throwback resurface, so the things B floats stay
// in front of him while he works. (Connections were dropped in the 2026-06-10
// overhaul — deterministic word-overlap pairs carried no real insight.)
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const ideas = getNewIdeas(5).map((i) => ({
      title: i.title,
      source: i.source,
      daysSince: i.daysSince,
    }));
    const throwback = getThrowback();
    return NextResponse.json({
      ideas,
      throwback: throwback
        ? { title: throwback.title, source: throwback.source, daysSince: throwback.daysSince }
        : null,
    });
  } catch {
    return NextResponse.json({ ideas: [], throwback: null });
  }
}
