import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub node-pty so constructing AgentPTY never touches the native addon.
import { vi } from 'vitest';
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

/**
 * SANDBOX CANARY flag-gating unit tests (Gate H / FEATURE_SANDBOX_CANARY).
 *
 * These assert the master kill-switch + canary-scope contract directly on the
 * spawn path, with no real flags file touched (CTX_FEATURE_FLAGS_PATH points at
 * a temp file per test). They prove:
 *   1. flag OFF  -> NO sandbox-exec wrapper for any agent (current prod behaviour)
 *   2. flag ON + sandbox_canary=true  -> sandbox-exec wrapper IS used (canary)
 *   3. flag ON + sandbox_canary missing/false -> NO wrapper (scope is one agent)
 *
 * Platform note: the wrapper branch also requires darwin. We run these only on
 * darwin (where the canary actually deploys); elsewhere they are skipped so the
 * suite stays green on Linux CI without asserting platform-specific behaviour.
 */

const isDarwin = process.platform === 'darwin';
const d = isDarwin ? describe : describe.skip;

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'atlas',
  agentDir: '/tmp/fw/orgs/main/agents/atlas',
  org: 'main',
  projectRoot: '/tmp/fw',
} as any;

// A recording spawn fn: captures the file the PTY would spawn, returns a stub IPty.
function recordingSpawn() {
  const calls: { file: string; args: string[] }[] = [];
  const fn = (file: string, args: string[]) => {
    calls.push({ file, args });
    // Minimal IPty stub — spawn() wires onData/onExit/etc on the returned object.
    return {
      pid: 1234,
      write() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      kill() {},
      resize() {},
    } as any;
  };
  return { calls, fn };
}

async function spawnAndCapture(config: any) {
  const { calls, fn } = recordingSpawn();
  const pty = new AgentPTY(mockEnv, config);
  // Inject the recording spawn fn (private field) so no native PTY is created.
  (pty as any).spawnFn = fn;
  await pty.spawn('fresh', 'PROMPT');
  return calls[0];
}

function writeFlags(value: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'canary-flags-'));
  const p = join(dir, 'feature-flags.json');
  writeFileSync(p, JSON.stringify({ FEATURE_SANDBOX_CANARY: value }), 'utf-8');
  return p;
}

const profile = '/Users/chrisjackson/cortextos/config/sandbox/cortextos-atlas-canary.sb';

d('SANDBOX CANARY flag-gating (FEATURE_SANDBOX_CANARY master kill-switch)', () => {
  const created: string[] = [];
  const prevFlagsPath = process.env.CTX_FEATURE_FLAGS_PATH;

  beforeEach(() => {
    delete process.env.CTX_FEATURE_FLAGS_PATH;
  });
  afterEach(() => {
    if (prevFlagsPath === undefined) delete process.env.CTX_FEATURE_FLAGS_PATH;
    else process.env.CTX_FEATURE_FLAGS_PATH = prevFlagsPath;
    for (const f of created.splice(0)) {
      try { rmSync(join(f, '..'), { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('flag OFF: NO sandbox-exec wrapper even when sandbox_profile + sandbox_canary are set (prod default)', async () => {
    const fp = writeFlags(false);
    created.push(fp);
    process.env.CTX_FEATURE_FLAGS_PATH = fp;
    const call = await spawnAndCapture({ sandbox_profile: profile, sandbox_canary: true });
    expect(call.file).not.toBe('sandbox-exec');
  });

  it('flag ON + sandbox_canary=true: sandbox-exec wrapper IS used (the canary)', async () => {
    const fp = writeFlags(true);
    created.push(fp);
    process.env.CTX_FEATURE_FLAGS_PATH = fp;
    const call = await spawnAndCapture({ sandbox_profile: profile, sandbox_canary: true });
    expect(call.file).toBe('sandbox-exec');
    // profile passed via -f, and the fake-canary deny param is threaded through
    expect(call.args).toContain('-f');
    expect(call.args).toContain(profile);
    expect(call.args.some((a) => a.startsWith('FAKE_CANARY_DIR='))).toBe(true);
  });

  it('flag ON but sandbox_canary NOT set: NO wrapper (scope is one canary agent, not fleet-wide)', async () => {
    const fp = writeFlags(true);
    created.push(fp);
    process.env.CTX_FEATURE_FLAGS_PATH = fp;
    const call = await spawnAndCapture({ sandbox_profile: profile });
    expect(call.file).not.toBe('sandbox-exec');
  });

  it('flag ON + sandbox_canary=false: NO wrapper (explicit opt-out honoured)', async () => {
    const fp = writeFlags(true);
    created.push(fp);
    process.env.CTX_FEATURE_FLAGS_PATH = fp;
    const call = await spawnAndCapture({ sandbox_profile: profile, sandbox_canary: false });
    expect(call.file).not.toBe('sandbox-exec');
  });
});
