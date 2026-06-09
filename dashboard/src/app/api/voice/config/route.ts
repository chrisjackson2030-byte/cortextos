import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VOICE_CONFIG = path.join(
  os.homedir(),
  'cortextos/orgs/main/agents/jarvis/state/voice-config.json',
);

const MODELS_DIR = path.join(os.homedir(), 'cortextos');

const AVAILABLE_VOICES = [
  { id: 'en_US-ryan-high', name: 'Ryan', accent: 'American', gender: 'Male', description: 'Clear, neutral male voice' },
  { id: 'en_GB-alan-medium', name: 'Alan', accent: 'British', gender: 'Male', description: 'British male — closest to Iron Man Jarvis' },
  { id: 'en_US-amy-medium', name: 'Amy', accent: 'American', gender: 'Female', description: 'Natural female voice' },
  { id: 'en_US-lessac-medium', name: 'Lessac', accent: 'American', gender: 'Male', description: 'Warm, expressive male voice' },
];

function getConfig(): { voice: string; speed: number } {
  try {
    const data = JSON.parse(fs.readFileSync(VOICE_CONFIG, 'utf-8'));
    return {
      voice: data.voice || 'en_US-ryan-high',
      speed: typeof data.speed === 'number' ? data.speed : 1.2,
    };
  } catch {
    return { voice: 'en_US-ryan-high', speed: 1.2 };
  }
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = getConfig();
  const voices = AVAILABLE_VOICES.map((v) => ({
    ...v,
    active: v.id === config.voice,
    installed: fs.existsSync(path.join(MODELS_DIR, `${v.id}.onnx`)),
  }));

  return NextResponse.json({ current: config.voice, speed: config.speed, voices });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { voice?: string; speed?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const existing = getConfig();
  const voice = body.voice || existing.voice;
  const speed = typeof body.speed === 'number' ? Math.max(0.5, Math.min(2.0, body.speed)) : existing.speed;

  if (!AVAILABLE_VOICES.some((v) => v.id === voice)) {
    return NextResponse.json({ error: 'Invalid voice ID' }, { status: 400 });
  }

  const modelPath = path.join(MODELS_DIR, `${voice}.onnx`);
  if (!fs.existsSync(modelPath)) {
    return NextResponse.json({ error: 'Voice model not installed' }, { status: 404 });
  }

  const config = { voice, speed, updated_at: new Date().toISOString() };
  fs.writeFileSync(VOICE_CONFIG, JSON.stringify(config, null, 2) + '\n');

  return NextResponse.json({ current: voice, speed, status: 'updated' });
}
