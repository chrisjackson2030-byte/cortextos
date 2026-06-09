import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const SIGNALS_PATH = path.join(
  os.homedir(),
  'cortextos/orgs/main/agents/jarvis/state/usaspending-signals.jsonl',
);

interface SentinelAlert {
  ts: string;
  ticker: string;
  award_amount: number;
  agency: string;
  score: number;
  description: string;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!fs.existsSync(SIGNALS_PATH)) {
    return NextResponse.json({ alerts: [] });
  }

  try {
    const raw = fs.readFileSync(SIGNALS_PATH, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // Parse all lines, take last 5 (most recent)
    const alerts: SentinelAlert[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SentinelAlert;
        alerts.push({
          ts: parsed.ts,
          ticker: parsed.ticker,
          award_amount: parsed.award_amount,
          agency: parsed.agency,
          score: parsed.score,
          description: parsed.description,
        });
      } catch {
        // skip malformed lines
      }
    }

    // Return last 5, newest first
    return NextResponse.json({ alerts: alerts.slice(-5).reverse() });
  } catch {
    return NextResponse.json({ alerts: [] });
  }
}
