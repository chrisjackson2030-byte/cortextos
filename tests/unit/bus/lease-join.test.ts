import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { completeRun, expireStaleRuns, joinRun, startRun } from '../../../src/bus/run-store';
import type { CompletionEnvelope } from '../../../src/types';

describe('run store lease and join', () => {
  let ctxRoot: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'lease-join-'));
    process.env.CTX_ROOT = ctxRoot;
    process.env.CTX_ORG = 'main';
    process.env.CTX_AGENT_NAME = 'jarvis';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('returns stalled when joining a run whose lease is already expired', () => {
    const started = startRun('trace-expired', -1);
    expect(started).not.toBeNull();

    const joined = joinRun(started!.run_id);
    expect(joined).toMatchObject({
      run_id: started!.run_id,
      status: 'stalled',
    });
  });

  it('returns running when joining a run still within its lease', () => {
    const started = startRun('trace-live', 60);
    expect(started).not.toBeNull();

    const joined = joinRun(started!.run_id);
    expect(joined).toMatchObject({
      run_id: started!.run_id,
      status: 'running',
    });
  });

  it('returns a terminal run unchanged', () => {
    const started = startRun('trace-terminal', 60);
    expect(started).not.toBeNull();

    const envelope: CompletionEnvelope = {
      run_id: started!.run_id,
      status: 'failed',
      result: 'worker failed',
      signature: started!.run_token,
      emitted_at: '2026-06-18T12:00:00Z',
    };
    const completed = completeRun(envelope);
    expect(completed).toMatchObject({
      run_id: started!.run_id,
      status: 'failed',
    });

    const joined = joinRun(started!.run_id);
    expect(joined).toEqual(completed);
  });

  it('expires only stale running runs', () => {
    const expired = startRun('trace-expired-bulk', -1);
    const active = startRun('trace-active-bulk', 60);
    expect(expired).not.toBeNull();
    expect(active).not.toBeNull();

    const changed = expireStaleRuns();
    expect(changed).toBe(1);

    expect(joinRun(expired!.run_id)).toMatchObject({
      run_id: expired!.run_id,
      status: 'stalled',
    });
    expect(joinRun(active!.run_id)).toMatchObject({
      run_id: active!.run_id,
      status: 'running',
    });
  });
});
