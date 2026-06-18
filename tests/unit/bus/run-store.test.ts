import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { completeRun, getRun, getRunByTrace, startRun } from '../../../src/bus/run-store';
import type { CompletionEnvelope } from '../../../src/types';

describe('run store', () => {
  let ctxRoot: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
    process.env.CTX_ROOT = ctxRoot;
    process.env.CTX_ORG = 'main';
    process.env.CTX_AGENT_NAME = 'jarvis';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('starts a run, completes it, stays idempotent, and rejects the wrong token', () => {
    const started = startRun('trace-123');
    expect(started).toMatchObject({
      trace_id: 'trace-123',
    });
    expect(started?.run_id).toMatch(/^run_\d+_[0-9a-f]{6}$/);
    expect(started?.run_token).toMatch(/^[0-9a-f]{16}$/);

    const dbPath = join(ctxRoot, 'orgs', 'main', 'analytics', 'runs.db');
    expect(existsSync(dbPath)).toBe(true);

    expect(getRun(started!.run_id)).toMatchObject({
      run_id: started!.run_id,
      trace_id: 'trace-123',
      run_token: started!.run_token,
      status: 'running',
    });
    expect(getRunByTrace('trace-123')).toMatchObject({
      run_id: started!.run_id,
    });

    const envelope: CompletionEnvelope = {
      run_id: started!.run_id,
      status: 'done',
      result: 'completed successfully',
      artifacts: ['artifact-a', 'artifact-b'],
      blockers: ['none'],
      next_action: 'notify user',
      signature: started!.run_token,
      emitted_at: '2026-06-18T12:00:00Z',
    };

    const completed = completeRun(envelope);
    expect(completed).toMatchObject({
      run_id: started!.run_id,
      status: 'done',
      result: 'completed successfully',
      artifacts: ['artifact-a', 'artifact-b'],
      blockers: ['none'],
      next_action: 'notify user',
      emitted_at: '2026-06-18T12:00:00Z',
    });

    const duplicate = completeRun({
      ...envelope,
      result: 'should not overwrite',
      artifacts: ['artifact-c'],
      blockers: ['blocked-now'],
      next_action: 'different next action',
      emitted_at: '2026-06-18T13:00:00Z',
    });
    expect(duplicate).toEqual(completed);

    expect(() =>
      completeRun({
        run_id: startRun('trace-456')!.run_id,
        status: 'failed',
        signature: 'deadbeefdeadbeef',
        emitted_at: '2026-06-18T13:30:00Z',
      }),
    ).toThrow('run_token mismatch');
  });
});
