import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VOICE_OUTBOX = path.join(
  os.homedir(),
  'cortextos/orgs/main/agents/jarvis/state/voice-outbound.jsonl',
);

const JARVIS_ROOT = path.join(os.homedir(), 'cortextos/orgs/main/agents/jarvis');
const ORG_ROOT = path.join(os.homedir(), 'cortextos/orgs/main');
const TELEGRAM_OUTBOX = path.join(JARVIS_ROOT, 'state/telegram-outbox.jsonl');

// Voice = talking to Jarvis in person. SHORT, continuous with the real Telegram
// conversation, opinionated. NOT the Telegram-wall-of-text persona.
const VOICE_SYSTEM_BASE = `You are Jarvis — B's chief of staff, talking to him by VOICE. This is a spoken conversation: he hears your answer, so it must be SHORT and natural, the way you'd actually talk, not a written report.

WHO B IS: real name Chris Jackson, goes by "B" exclusively (never "Chris"/"Jay"). ADHD, fast context-switching, late nights. He runs an autonomous AI agent fleet (you/Jarvis the orchestrator, plus Forge, Nova, Friday) on a Mac Mini M4 via cortextOS.

CONTINUITY (critical): You are the SAME Jarvis B has been talking to on Telegram. The RECENT TELEGRAM CONVERSATION is below — treat it as the conversation you are currently in. When B asks "what's going on / how are we doing / what's pending," answer about the REAL current state shown in the context, like you've been here the whole time (you have).

PERSONALITY: Direct, confident, no fluff — lead with the answer. Never sycophantic (no "Great question", "Sure thing"). Push back when B is wrong. Say "I don't know" rather than fabricate. Bad news first.

RESPONSE FORMAT (follow EXACTLY):
TL;DR: [1-3 SHORT sentences, UNDER 40 WORDS. This is SPOKEN ALOUD — keep it tight and conversational, like talking to him in person. Lead with the answer. No lists, no walls.]
---
[OPTIONAL: a few short bullets of detail, shown on screen only (NOT spoken). Under 100 words. Omit entirely if the TL;DR already answers.]
VIEW: [If B asks to see / pull up / show / open something, output exactly ONE of: predictions | trading | voice | status | activity. Otherwise output: none]

Rules: TL;DR under 40 words, always. Never start with "Sure"/"Great"/"Absolutely". Be opinionated — your real take, not hedging. No emojis unless B used one first.`;

function readFileSafe(filePath: string, maxChars = 2000): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return '';
  }
}

// Recent Telegram conversation (Jarvis's replies to B) → gives the voice the
// real context of what B and Jarvis are actually working on right now.
function recentTelegramConversation(n = 10): string {
  try {
    const raw = fs.readFileSync(TELEGRAM_OUTBOX, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-n).map((ln) => {
      try {
        const o = JSON.parse(ln);
        const text = String(o.text || '').replace(/\s+/g, ' ').slice(0, 280);
        return `Jarvis→B: ${text}`;
      } catch {
        return '';
      }
    }).filter(Boolean);
    return recent.length ? recent.join('\n') : '';
  } catch {
    return '';
  }
}

function gatherLiveContext(): string {
  const parts: string[] = [];

  const goals = readFileSafe(path.join(ORG_ROOT, 'goals.json'), 800);
  if (goals) {
    try {
      const g = JSON.parse(goals);
      parts.push(`GOALS: North star: ${g.north_star_vehicle || g.north_star}. Today's focus: ${g.daily_focus}. Phase: ${g.phase}.`);
    } catch { /* skip */ }
  }

  const agents = ['jarvis', 'forge', 'nova', 'friday'];
  const hbRoot = path.join(os.homedir(), '.cortextos/default/state');
  const heartbeats: string[] = [];
  for (const agent of agents) {
    const hbPath = path.join(hbRoot, `${agent}/heartbeat.json`);
    const hb = readFileSafe(hbPath, 300);
    if (hb) {
      try {
        const h = JSON.parse(hb);
        const ts = h.last_heartbeat || h.last_seen;
        const ago = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 60000) : -1;
        heartbeats.push(`${agent}: ${h.display_name || agent} (${ago}m ago) — ${h.status || 'unknown'}`);
      } catch { /* skip */ }
    }
  }
  if (heartbeats.length > 0) {
    parts.push(`FLEET:\n${heartbeats.join('\n')}`);
  }

  const convo = recentTelegramConversation(10);
  if (convo) {
    parts.push(`RECENT TELEGRAM CONVERSATION (you and B, most recent last — this is the conversation you're in):\n${convo}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const memoryFile = path.join(JARVIS_ROOT, `memory/${today}.md`);
  const memory = readFileSafe(memoryFile, 1500);
  if (memory) {
    const lines = memory.split('\n').slice(-25).join('\n');
    parts.push(`TODAY'S LOG (last 25 lines):\n${lines}`);
  }

  const pendingFile = readFileSafe(path.join(JARVIS_ROOT, 'state/pending-b-decisions.md'), 800);
  if (pendingFile) {
    const lines = pendingFile.split('\n');
    const queueItems: string[] = [];
    let inQueue = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '## Queue') { inQueue = true; continue; }
      if (trimmed.startsWith('## ') && inQueue) break;
      if (trimmed === '---' && inQueue) break;
      if (inQueue && trimmed.startsWith('- ') && trimmed.length > 3 && !trimmed.includes('**')) {
        queueItems.push(trimmed.slice(2));
      }
    }
    if (queueItems.length > 0) {
      parts.push(`PENDING B DECISIONS:\n${queueItems.map(q => `- ${q}`).join('\n')}`);
    }
  }

  return parts.length > 0 ? '\n\nLIVE CONTEXT:\n' + parts.join('\n\n') : '';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function callClaude(input: string, model: 'haiku' | 'sonnet' | 'opus' = 'sonnet', timeoutMs = 22000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', '--model', model], {
      env: { ...process.env, PATH: `${os.homedir()}/.local/bin:${process.env.PATH}` },
      cwd: os.homedir(),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

const VALID_VIEWS = new Set(['predictions', 'trading', 'voice', 'status', 'activity']);

function parseResponse(raw: string): { tldr: string; full: string; view: string } {
  let view = 'none';
  let body = raw;
  // Pull a trailing VIEW: directive off the end if present.
  const viewMatch = body.match(/\n?VIEW:\s*([a-z]+)\s*$/i);
  if (viewMatch) {
    const v = viewMatch[1].toLowerCase();
    if (VALID_VIEWS.has(v)) view = v;
    body = body.slice(0, viewMatch.index).trim();
  }
  const divider = body.indexOf('\n---');
  if (divider !== -1) {
    const tldr = body.slice(0, divider).replace(/^TL;DR:\s*/i, '').trim();
    const full = body.slice(divider + 4).trim();
    return { tldr, full, view };
  }
  const tldr = body.replace(/^TL;DR:\s*/i, '').trim();
  return { tldr, full: '', view };
}

// Dedup guard (fixes the double-speak): skip the append if the last outbox entry
// has an identical tldr written within the last 10s (double POST / retry).
function isDuplicate(tldr: string): boolean {
  try {
    const raw = fs.readFileSync(VOICE_OUTBOX, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return false;
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.tldr !== tldr) return false;
    const age = Date.now() - new Date(last.ts).getTime();
    return age >= 0 && age < 10000;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { text?: string; history?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { text, history } = body;
  if (!text || typeof text !== 'string' || text.length > 5000) {
    return NextResponse.json({ error: 'Invalid text' }, { status: 400 });
  }

  const liveContext = gatherLiveContext();
  let prompt = VOICE_SYSTEM_BASE + liveContext + '\n\n';

  if (history && history.length > 0) {
    prompt += 'This voice session so far:\n';
    for (const msg of history.slice(-12)) {
      prompt += `${msg.role === 'user' ? 'B' : 'Jarvis'}: ${msg.content}\n`;
    }
    prompt += '\n';
  }
  prompt += `B: ${text}`;

  try {
    // ONE brief answer, every time. No background deep-think second reply — that
    // was the double-speak + the walls B did not want. Sonnet = smart + fast.
    const raw = await callClaude(prompt, 'sonnet', 22000);
    const { tldr, full, view } = parseResponse(raw);
    const ts = new Date().toISOString();

    if (!isDuplicate(tldr)) {
      fs.appendFileSync(VOICE_OUTBOX, JSON.stringify({ ts, tldr, full, view }) + '\n');
    }

    return NextResponse.json({ tldr, full, ts, view });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Voice chat error:', message);
    return NextResponse.json(
      { error: 'Failed to generate response' },
      { status: 500 },
    );
  }
}
