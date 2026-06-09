import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import fg from 'fast-glob';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const CTX_ROOT =
  process.env.CTX_ROOT ||
  path.join(os.homedir(), '.cortextos', process.env.CTX_INSTANCE_ID ?? 'default');
const CORTEXTOS_REPO =
  process.env.CORTEXTOS_REPO || path.join(os.homedir(), 'cortextos');

interface VoiceMessage {
  direction: 'inbound' | 'outbound';
  agent: string;
  text: string;
  ts: string;
}

function readLastNLines(filePath: string, n: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10) || 50,
    200,
  );

  const messages: VoiceMessage[] = [];

  const inboundFiles = fg.sync(
    path.join(CTX_ROOT, 'logs', '*', 'inbound-messages.jsonl'),
    { onlyFiles: true },
  );
  for (const fp of inboundFiles) {
    const agentMatch = fp.match(/logs\/([^/]+)\//);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    for (const line of readLastNLines(fp, limit)) {
      try {
        const entry = JSON.parse(line);
        if (!entry.text) continue;
        messages.push({
          direction: 'inbound',
          agent,
          text: entry.text,
          ts: entry.timestamp || entry.ts || new Date().toISOString(),
        });
      } catch { /* skip malformed */ }
    }
  }

  const outboundFiles = fg.sync(
    path.join(CORTEXTOS_REPO, 'orgs', '*', 'agents', '*', 'state', 'telegram-outbox.jsonl'),
    { onlyFiles: true },
  );
  for (const fp of outboundFiles) {
    const agentMatch = fp.match(/agents\/([^/]+)\/state/);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    for (const line of readLastNLines(fp, limit)) {
      try {
        const entry = JSON.parse(line);
        if (!entry.text) continue;
        messages.push({
          direction: 'outbound',
          agent,
          text: entry.text,
          ts: entry.ts || entry.timestamp || new Date().toISOString(),
        });
      } catch { /* skip malformed */ }
    }
  }

  messages.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const recent = messages.slice(-limit);

  return NextResponse.json({ messages: recent });
}
