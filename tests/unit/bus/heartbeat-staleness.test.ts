import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAgentCadenceMs, isHeartbeatStale } from '../../../src/bus/heartbeat';
import type { Heartbeat } from '../../../src/types/index';

function makeHb(agent: string, org: string, ageMs: number, now: number): Heartbeat {
  return {
    agent,
    org,
    status: 'online',
    current_task: '',
    mode: 'day',
    last_heartbeat: new Date(now - ageMs).toISOString(),
    loop_interval: '',
  };
}

function writeConfig(frameworkRoot: string, org: string, agent: string, interval: string | null): void {
  const dir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const crons = interval === null
    ? []
    : [{ name: 'heartbeat', type: 'recurring', interval, prompt: 'x' }];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ crons }));
}

describe('getAgentCadenceMs', () => {
  let fw: string;
  beforeEach(() => { fw = mkdtempSync(join(tmpdir(), 'cadence-')); });
  afterEach(() => { rmSync(fw, { recursive: true, force: true }); });

  it('reads the 4h heartbeat cron interval', () => {
    writeConfig(fw, 'main', 'friday', '4h');
    expect(getAgentCadenceMs(fw, 'main', 'friday')).toBe(4 * 3_600_000);
  });

  it('reads a 30m interval', () => {
    writeConfig(fw, 'main', 'pulse', '30m');
    expect(getAgentCadenceMs(fw, 'main', 'pulse')).toBe(30 * 60_000);
  });

  it('falls back to 4h default when config is missing', () => {
    expect(getAgentCadenceMs(fw, 'main', 'ghost')).toBe(4 * 3_600_000);
  });

  it('falls back to default when no parseable interval (cron expr only)', () => {
    const dir = join(fw, 'orgs', 'main', 'agents', 'crononly');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      crons: [{ name: 'heartbeat', interval: '0 8 * * *' }],
    }));
    expect(getAgentCadenceMs(fw, 'main', 'crononly')).toBe(4 * 3_600_000);
  });

  it('falls back to default when frameworkRoot or org is empty', () => {
    expect(getAgentCadenceMs('', 'main', 'friday')).toBe(4 * 3_600_000);
    expect(getAgentCadenceMs(fw, '', 'friday')).toBe(4 * 3_600_000);
  });
});

describe('isHeartbeatStale (cadence-aware)', () => {
  let fw: string;
  const now = Date.UTC(2026, 5, 15, 18, 0, 0);
  beforeEach(() => { fw = mkdtempSync(join(tmpdir(), 'stale-')); });
  afterEach(() => { rmSync(fw, { recursive: true, force: true }); });

  it('does NOT false-flag a healthy 4h-cadence agent at 3h silence', () => {
    writeConfig(fw, 'main', 'friday', '4h');
    const hb = makeHb('friday', 'main', 3 * 3_600_000, now);
    // OLD behaviour flagged STALE >2h; cadence-aware threshold is 10h.
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(false);
  });

  it('does NOT flag a 4h-cadence agent that missed one beat (9h silence)', () => {
    writeConfig(fw, 'main', 'nova', '4h');
    const hb = makeHb('nova', 'main', 9 * 3_600_000, now);
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(false);
  });

  it('DOES flag a 4h-cadence agent past the 10h threshold', () => {
    writeConfig(fw, 'main', 'nova', '4h');
    const hb = makeHb('nova', 'main', 11 * 3_600_000, now);
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(true);
  });

  it('honours the 2h floor for short-cadence agents (10m cadence, 1h silence not stale)', () => {
    // cadence 10m * 2.5 = 25m, but floor is 2h, so 1h silence is NOT stale.
    writeConfig(fw, 'main', 'pulse', '10m');
    const hb = makeHb('pulse', 'main', 60 * 60_000, now);
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(false);
  });

  it('flags a short-cadence agent past the 2h floor', () => {
    writeConfig(fw, 'main', 'pulse', '10m');
    const hb = makeHb('pulse', 'main', 3 * 3_600_000, now);
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(true);
  });

  it('treats an unparseable timestamp as stale', () => {
    writeConfig(fw, 'main', 'friday', '4h');
    const hb = { ...makeHb('friday', 'main', 0, now), last_heartbeat: 'not-a-date' };
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(true);
  });

  it('uses the default cadence (10h threshold) when config is absent', () => {
    // No config => DEFAULT_CADENCE_MS (4h) * 2.5 = 10h threshold.
    const hb = makeHb('orphan', 'main', 9 * 3_600_000, now);
    expect(isHeartbeatStale(hb, fw, 'main', now)).toBe(false);
    const hbDead = makeHb('orphan', 'main', 11 * 3_600_000, now);
    expect(isHeartbeatStale(hbDead, fw, 'main', now)).toBe(true);
  });
});
