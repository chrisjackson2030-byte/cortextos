import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import { resolveEnv } from '../utils/env.js';

export interface OutcomeHeartbeat {
  ts: string;
  agent: string;
  metric: string;
  value: number;
  min_expected: number;
  healthy: boolean;
}

function outcomeDir(agent: string): string {
  const env = resolveEnv({ agentName: agent });
  const orgBase = env.org ? join(env.ctxRoot, 'orgs', env.org) : env.ctxRoot;
  return join(orgBase, 'analytics', 'outcome-hb', agent);
}

export function writeOutcomeHeartbeat(agent: string, metric: string, value: number, minExpected: number): void {
  try {
    const dir = outcomeDir(agent);
    ensureDir(dir);
    const record: OutcomeHeartbeat = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent,
      metric,
      value,
      min_expected: minExpected,
      healthy: value >= minExpected,
    };
    const today = record.ts.split('T')[0];
    appendFileSync(join(dir, `${today}.jsonl`), JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Best-effort only — outcome heartbeat must never block callers.
  }
}

export function readLatestOutcomeHeartbeat(agent: string, metric?: string): OutcomeHeartbeat | null {
  try {
    const dir = outcomeDir(agent);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((file) => file.endsWith('.jsonl')).sort().reverse();
    for (const file of files) {
      const lines = readFileSync(join(dir, file), 'utf-8').trim().split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as OutcomeHeartbeat;
          if (!metric || record.metric === metric) return record;
        } catch {
          // Ignore malformed lines and keep scanning for the newest valid record.
        }
      }
    }
  } catch {
    // Best-effort read.
  }
  return null;
}
