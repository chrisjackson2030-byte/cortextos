/**
 * no-env-worker-seam.test.ts — ITEM 5b proof.
 *
 * Proves production cannot activate a deterministic / arbitrary worker command
 * via ANY env var. We construct the spawn path the PRODUCTION way (no injected
 * WorkerFactory), set CTX_TEST_WORKER_CMD (and a few plausible aliases) in the
 * environment, and assert the command AgentPTY would spawn is still the real
 * `claude` binary — the env vars have NO effect.
 *
 * We capture the spawn target by injecting a spawnFn stub onto AgentPTY (NOT a
 * WorkerFactory) purely to observe `file`; this does not exercise any product
 * code path that reads env for command selection (there is none).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentPTY } from '../../src/pty/agent-pty.js';
import type { CtxEnv } from '../../src/types/index.js';

const envBackup = { ...process.env };
afterEach(() => { process.env = { ...envBackup }; });

describe('ITEM 5b — no env-var worker seam in production', () => {
  it('CTX_TEST_WORKER_CMD (and aliases) set in env has NO effect; spawn target is real claude', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jcv1seamb-5b-'));
    // Attacker-style env: try to replace the worker command via env.
    process.env.CTX_TEST_WORKER_CMD = '/usr/bin/evil';
    process.env.CTX_WORKER_CMD = '/usr/bin/evil2';
    process.env.WORKER_CMD = '/usr/bin/evil3';

    const env: CtxEnv = {
      instanceId: 'jcv1seamb-5b',
      ctxRoot: tmp,
      frameworkRoot: tmp,
      agentName: 'prod-worker',
      agentDir: tmp,
      org: 'main',
      projectRoot: tmp,
    };

    // PRODUCTION construction: NO workerFactory argument.
    const pty = new AgentPTY(env, {}, join(tmp, 'out.log'));

    let spawnedFile: string | null = null;
    let spawnedArgs: string[] = [];
    // Inject a spawnFn ONLY to observe the resolved file/args (this is the
    // node-pty boundary, not a command-selection seam).
    (pty as unknown as { spawnFn: (f: string, a: string[], o: unknown) => unknown }).spawnFn =
      (file: string, args: string[]) => {
        spawnedFile = file;
        spawnedArgs = args;
        // Return a minimal IPty-like stub so spawn() completes.
        return {
          pid: 1234,
          write() {},
          onData() { return { dispose() {} }; },
          onExit() { return { dispose() {} }; },
          kill() {},
          resize() {},
        };
      };

    await pty.spawn('fresh', 'task prompt');

    // The spawn target is the real claude binary, NOT any env-provided command.
    expect(spawnedFile).toBe('claude');
    expect(spawnedFile).not.toContain('evil');
    expect(spawnedArgs.join(' ')).not.toContain('evil');
    // And the prompt is the real claude arg, proving buildClaudeArgs ran.
    expect(spawnedArgs).toContain('task prompt');

    pty.kill();
    rmSync(tmp, { recursive: true, force: true });
  });
});
