/**
 * tests/unit/daemon/loop-fire-ledger.test.ts
 *
 * Phase 3 harness-ledger fix (Test A, 2026-06-18).
 *
 * Proves: when the daemon's CronScheduler fires a cron (the harness-triggered
 * path), the native loop-fire-ledger is written AUTOMATICALLY — no manual
 * backfill — so the python-side staleness detectors (system_doctor, lane-health,
 * reconciler) do not false-flag a RUNNING loop as stale.
 *
 * Isolation: CTX_LOOP_FIRE_LEDGER + CTX_ROOT point at temp paths so the test
 * never touches the real ledger or state dir. Timing via vitest fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock crons I/O BEFORE importing CronScheduler (same pattern as cron-scheduler.test.ts).
const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
vi.mock('../../../src/bus/crons.js', () => ({
  readCrons: (...args: unknown[]) => mockReadCrons(...args),
  readCronsWithStatus: (...args: unknown[]) => mockReadCronsWithStatus(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler';
import { appendLoopFireLedger } from '../../../src/daemon/cron-execution-log';
import type { CronDefinition } from '../../../src/types/index';

const TICK = CronScheduler.TICK_INTERVAL_MS;

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'test-cron',
    prompt: 'Do something.',
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('loop-fire-ledger (Phase 3 harness-ledger fix)', () => {
  let tmp: string;
  let ledgerPath: string;
  let prevLedger: string | undefined;
  let prevRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'loopfire-'));
    ledgerPath = join(tmp, 'loop-fire-ledger.jsonl');
    prevLedger = process.env.CTX_LOOP_FIRE_LEDGER;
    prevRoot = process.env.CTX_ROOT;
    process.env.CTX_LOOP_FIRE_LEDGER = ledgerPath;
    process.env.CTX_ROOT = tmp; // isolate appendExecutionLog too
  });

  afterEach(() => {
    if (prevLedger === undefined) delete process.env.CTX_LOOP_FIRE_LEDGER;
    else process.env.CTX_LOOP_FIRE_LEDGER = prevLedger;
    if (prevRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = prevRoot;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('appendLoopFireLedger writes a correctly-shaped record (no backfill needed)', () => {
    appendLoopFireLedger('heartbeat', 'jarvis');
    expect(existsSync(ledgerPath)).toBe(true);
    const rec = JSON.parse(readFileSync(ledgerPath, 'utf-8').trim());
    expect(rec.name).toBe('heartbeat');
    expect(rec.agent).toBe('jarvis');
    expect(rec.source).toBe('daemon-cron-fire');
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // ts is fresh (within the last minute) -> a staleness detector sees it as a real fresh fire
    expect(Date.now() - new Date(rec.ts).getTime()).toBeLessThan(60_000);
  });

  it('a harness-triggered scheduler FIRE auto-writes the ledger', async () => {
    vi.useFakeTimers();
    try {
      mockReadCrons.mockReturnValue([makeCron({ name: 'revenue-orchestrator', schedule: '1m' })]);
      mockReadCronsWithStatus.mockImplementation((agent: string) => ({
        crons: mockReadCrons(agent) ?? [],
        corrupt: false,
      }));
      const fired: CronDefinition[] = [];
      const scheduler = new CronScheduler({
        agentName: 'jarvis',
        onFire: (cron) => { fired.push(cron); },
        logger: () => {},
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(60_000 + TICK);
      scheduler.stop();

      // the cron actually fired
      expect(fired).toHaveLength(1);
      // AND the native loop-fire-ledger was written automatically (no manual backfill)
      expect(existsSync(ledgerPath)).toBe(true);
      const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const rec = JSON.parse(lines[lines.length - 1]);
      expect(rec.name).toBe('revenue-orchestrator');
      expect(rec.source).toBe('daemon-cron-fire');
      expect(rec.agent).toBe('jarvis');
    } finally {
      vi.useRealTimers();
    }
  });
});
