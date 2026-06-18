import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeOutcomeHeartbeat, readLatestOutcomeHeartbeat } from '../../../src/bus/outcome-hb';

describe('outcome heartbeat', () => {
  let ctxRoot: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'outcome-hb-'));
    process.env.CTX_ROOT = ctxRoot;
    process.env.CTX_ORG = 'main';
    process.env.CTX_AGENT_NAME = 'jarvis';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('writes a daily JSONL record and reads the latest matching metric', () => {
    writeOutcomeHeartbeat('jarvis', 'canary_events', 1, 1);
    writeOutcomeHeartbeat('jarvis', 'canary_events', 3, 1);
    writeOutcomeHeartbeat('jarvis', 'other_metric', 0, 2);

    const today = new Date().toISOString().split('T')[0];
    const hbFile = join(ctxRoot, 'orgs', 'main', 'analytics', 'outcome-hb', 'jarvis', `${today}.jsonl`);
    expect(existsSync(hbFile)).toBe(true);

    const lines = readFileSync(hbFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      agent: 'jarvis',
      metric: 'canary_events',
      value: 1,
      min_expected: 1,
      healthy: true,
    });

    expect(readLatestOutcomeHeartbeat('jarvis', 'canary_events')).toMatchObject({
      metric: 'canary_events',
      value: 3,
      min_expected: 1,
      healthy: true,
    });
    expect(readLatestOutcomeHeartbeat('jarvis', 'other_metric')).toMatchObject({
      metric: 'other_metric',
      value: 0,
      min_expected: 2,
      healthy: false,
    });
    expect(readLatestOutcomeHeartbeat('jarvis', 'missing_metric')).toBeNull();
  });
});
