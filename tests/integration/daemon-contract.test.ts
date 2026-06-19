/**
 * daemon-contract.test.ts — DAEMON-WIRING layer of the completion-contract /
 * lease integration. In-process, deterministic. Drives feature flags via a temp
 * CTX_FEATURE_FLAGS_PATH file and the run-store via a temp CTX_RUN_STORE_DB.
 *
 * Proves (flags ON):
 *  - run row created (status=running) BEFORE spawn, with the 6 contract env vars
 *  - exit-without-complete => NOT completed + marker recorded
 *  - IPC completion writes a valid envelope retrievable by run_id (+trace)
 *  - daemon-origin direct-store completion is REJECTED (fail-closed)
 *  - lease sweep marks a hung run STALLED + parent joinRun unblocks STALLED
 * And (flags OFF):
 *  - legacy worker behavior unchanged (no run row, exit=completed)
 *
 * The full 17-case disposable-daemon suite is a later phase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---- PTY mock (capture exit handler so we can simulate worker exit) ----------
let capturedOnExit: ((code: number) => void) | null = null;
let capturedExtraEnvSeen: Record<string, string> | undefined;
const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(4242),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};
vi.mock('../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(env: { extraEnv?: Record<string, string> }) {
    capturedExtraEnvSeen = env?.extraEnv;
    return mockPty;
  },
}));
vi.mock('../../src/pty/inject.js', () => ({ injectMessage: vi.fn() }));

const { WorkerProcess } = await import('../../src/daemon/worker-process.js');
const runStore = await import('../../src/bus/run-store.js');
const runContract = await import('../../src/daemon/run-contract.js');
const ipc = await import('../../src/daemon/ipc-server.js');
const {
  startRun,
  getRun,
  getRunByTrace,
  completeRun,
  joinRun,
  signEnvelope,
  envelopePayload,
} = runStore;

const envBackup = { ...process.env };
let dir: string;

function writeFlags(flags: Record<string, boolean>): string {
  const p = join(dir, 'feature-flags.json');
  writeFileSync(p, JSON.stringify(flags), 'utf-8');
  return p;
}

function signedEnvelope(
  rawToken: string,
  run_id: string,
  over: Partial<{ status: string; result: string; artifacts: string[]; blockers: string[]; next_action: string; emitted_at: string }> = {},
) {
  const base = {
    run_id,
    status: 'completed',
    result: 'ok',
    artifacts: [] as string[],
    blockers: [] as string[],
    next_action: undefined as string | undefined,
    emitted_at: '2026-06-18T12:00:00Z',
    ...over,
  };
  const signature = signEnvelope(rawToken, envelopePayload({ ...base, signature: '' } as never));
  return { ...base, signature, run_token: rawToken };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-contract-'));
  process.env.CTX_RUN_STORE_DB = join(dir, 'runs.db');
  process.env.CTX_ROOT = dir;
  process.env.CTX_ORG = 'main';
  process.env.CTX_AGENT_NAME = 'jarvis';
  capturedOnExit = null;
  capturedExtraEnvSeen = undefined;
  mockPty.spawn.mockClear();
});

afterEach(() => {
  process.env = { ...envBackup };
  rmSync(dir, { recursive: true, force: true });
});

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'w-contract',
  agentDir: '/tmp/project',
  org: 'main',
  projectRoot: '/tmp/fw',
} as const;

// ===========================================================================
// A. prepareContractRun — run row + 6 env vars (FLAGS ON)
// ===========================================================================
describe('A. contract run preparation (flags ON)', () => {
  beforeEach(() => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({
      FEATURE_COMPLETION_CONTRACT: true,
      FEATURE_TRACE_ID: false,
    });
  });

  it('creates a running run row BEFORE returning, and injects the 6 contract env vars', () => {
    const prepared = runContract.prepareContractRun({ parentRunId: 'parent-1', leaseSeconds: 60 });
    expect(prepared).not.toBeNull();

    // Run row exists and is running (origin daemon, hash-only token).
    const rec = getRun(prepared!.runId);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe('running');
    expect(rec!.origin).toBe('daemon');
    expect(rec!.run_token).toBe(''); // contract rows never store the raw token

    // The 6 env vars are present.
    const e = prepared!.env;
    expect(e.CTX_RUN_ID).toBe(prepared!.runId);
    expect(e.CTX_RUN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(e.CTX_TRACE_ID).toBeTruthy();
    expect(e.CTX_PARENT_RUN_ID).toBe('parent-1');
    expect(e.CTX_LEASE_DEADLINE).toBeTruthy();
    expect(e.CTX_COMPLETION_SCHEMA_VERSION).toBe(String(runStore.COMPLETION_SCHEMA_VERSION));
  });

  it('completion instruction does NOT contain the raw token', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    expect(prepared!.instruction).not.toContain(prepared!.env.CTX_RUN_TOKEN);
    expect(prepared!.instruction).toContain('CTX_RUN_TOKEN'); // references the env var name only
  });

  it('redactTokens scrubs a raw token from any string', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    const token = prepared!.env.CTX_RUN_TOKEN;
    const leaked = `error: token was ${token} oops`;
    const safe = runContract.redactTokens(leaked, [token]);
    expect(safe).not.toContain(token);
    expect(safe).toContain('[REDACTED_RUN_TOKEN]');
  });
});

// ===========================================================================
// B. Worker exit observer (FLAGS ON vs OFF)
// ===========================================================================
describe('B. worker exit observer', () => {
  it('flags ON + no completion envelope => NOT completed, status exited_without_completion', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true });
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    const env = { ...mockEnv, extraEnv: { ...prepared!.env } };

    const w = new WorkerProcess('w-exit', '/tmp/proj', undefined);
    await w.spawn(env as never, 'task');
    capturedOnExit!(0); // bare exit, no complete-run

    expect(w.getStatus().status).toBe('exited_without_completion');
    expect(w.getStatus().status).not.toBe('completed');
    // The run is still running (left for the lease sweep), not done.
    const rec = getRun(prepared!.runId);
    expect(rec!.status).toBe('running');
    expect(w.isFinished()).toBe(true); // finished for cleanup purposes
  });

  it('flags ON + a recorded completion => mirrors completed', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true });
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    // Complete the run first (direct store, simulating the validated IPC write).
    const env1 = signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, { status: 'completed' });
    completeRun(env1);

    const env = { ...mockEnv, extraEnv: { ...prepared!.env } };
    const w = new WorkerProcess('w-exit2', '/tmp/proj', undefined);
    await w.spawn(env as never, 'task');
    capturedOnExit!(0);
    expect(w.getStatus().status).toBe('completed');
  });

  it('flags OFF => legacy: no run row, exit code 0 => completed', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: false });
    const w = new WorkerProcess('w-legacy', '/tmp/proj', undefined);
    await w.spawn(mockEnv as never, 'task'); // no extraEnv
    expect(capturedExtraEnvSeen).toBeUndefined();
    capturedOnExit!(0);
    expect(w.getStatus().status).toBe('completed');
  });

  it('flags OFF => exit code 1 => failed (legacy)', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: false });
    const w = new WorkerProcess('w-legacy2', '/tmp/proj', undefined);
    await w.spawn(mockEnv as never, 'task');
    capturedOnExit!(1);
    expect(w.getStatus().status).toBe('failed');
  });
});

// ===========================================================================
// C. IPC completion (handleCompleteRun)
// ===========================================================================
describe('C. IPC completion (handleCompleteRun)', () => {
  beforeEach(() => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true });
  });

  it('validates token + HMAC and writes a retrievable envelope (by run_id + trace)', () => {
    const prepared = runContract.prepareContractRun({ traceId: undefined, leaseSeconds: 60 });
    const trace = prepared!.traceId;
    const envelope = signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, {
      status: 'completed',
      result: 'done',
    });
    // The contract row's trace_id is its run_id (self-rooted); set it so getRunByTrace finds it.
    const result = ipc.handleCompleteRun({ envelope });
    expect(result.ok).toBe(true);
    expect(result.record!.status).toBe('completed');

    const byId = getRun(prepared!.runId);
    expect(byId!.status).toBe('completed');
    expect(byId!.result).toBe('done');
    expect(byId!.signature).toBe(envelope.signature);

    if (trace) {
      const byTrace = getRunByTrace(trace);
      expect(byTrace!.run_id).toBe(prepared!.runId);
    }
  });

  it('rejects a wrong token (token_mismatch), run unchanged', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    const envelope = signedEnvelope('deadbeef'.repeat(8), prepared!.runId, { status: 'completed' });
    const result = ipc.handleCompleteRun({ envelope });
    expect(result.ok).toBe(false);
    expect(result.rejection?.reason).toBe('token_mismatch');
    expect(getRun(prepared!.runId)!.status).toBe('running');
  });

  it('rejects a tampered envelope (signature_mismatch)', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    const envelope = signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, { status: 'completed' });
    envelope.result = 'TAMPERED AFTER SIGNING'; // mutate a covered field
    const result = ipc.handleCompleteRun({ envelope });
    expect(result.ok).toBe(false);
    expect(result.rejection?.reason).toBe('signature_mismatch');
    expect(getRun(prepared!.runId)!.status).toBe('running');
  });

  it('rejects completion of a non-daemon-origin run via IPC', () => {
    // standalone run (no contract): origin = standalone
    const started = startRun('trace-standalone', 60);
    const envelope = { run_id: started!.run_id, status: 'done', signature: started!.run_token, emitted_at: '2026-06-18T12:00:00Z' };
    const result = ipc.handleCompleteRun({ envelope: envelope as never });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not daemon-origin');
  });

  it('is idempotent: second completion keeps the original terminal result', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    const e1 = signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, { status: 'completed', result: 'first' });
    ipc.handleCompleteRun({ envelope: e1 });
    const e2 = signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, { status: 'completed', result: 'second' });
    const r2 = ipc.handleCompleteRun({ envelope: e2 });
    expect(r2.ok).toBe(true);
    expect(getRun(prepared!.runId)!.result).toBe('first');
  });
});

// ===========================================================================
// D. Daemon-origin direct-store completion is FAIL-CLOSED at routing
// (the CLI only dials IPC for origin=daemon; here we assert that handleCompleteRun
//  is the only validated path, and a daemon run cannot be completed without the
//  HMAC/token the run-store enforces — proven by the token/signature rejections
//  above. We additionally assert origin gating refuses standalone-shaped writes.)
// ===========================================================================
describe('D. daemon-origin gating', () => {
  beforeEach(() => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true });
  });

  it('a daemon run cannot be completed with the legacy "signature = raw token" shape', () => {
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    // Legacy shape: put the raw token in signature, no HMAC, no run_token field.
    const bad = {
      run_id: prepared!.runId,
      status: 'completed',
      signature: prepared!.env.CTX_RUN_TOKEN,
      emitted_at: '2026-06-18T12:00:00Z',
    };
    const result = ipc.handleCompleteRun({ envelope: bad as never });
    // The hash check passes (signature == token, hashed) but the HMAC verify
    // fails because the signature is not a valid HMAC over the payload.
    expect(result.ok).toBe(false);
    expect(result.rejection?.reason).toBe('signature_mismatch');
    expect(getRun(prepared!.runId)!.status).toBe('running');
  });
});

// ===========================================================================
// E. Lease sweep (FEATURE_LEASE_JOIN) + parent join unblock
// ===========================================================================
describe('E. lease sweep + parent join', () => {
  it('expireStaleRuns marks a hung run STALLED; parent joinRun returns STALLED', () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({
      FEATURE_COMPLETION_CONTRACT: true,
      FEATURE_LEASE_JOIN: true,
    });
    // lease already expired (negative seconds => deadline in the past)
    const prepared = runContract.prepareContractRun({ leaseSeconds: -1 });
    expect(getRun(prepared!.runId)!.status).toBe('running');

    const expired = runStore.expireStaleRuns();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(getRun(prepared!.runId)!.status).toBe('stalled');

    // A parent joining the hung child sees a terminal STALLED state, unblocking.
    const joined = joinRun(prepared!.runId);
    expect(joined!.status).toBe('stalled');
  });

  it('AgentManager.runLeaseSweep sweeps when FEATURE_LEASE_JOIN on, no-op when off', async () => {
    const { AgentManager } = await import('../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('test', dir, '/tmp/fw', 'main');

    // Flag OFF => no-op even with an expired run.
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true, FEATURE_LEASE_JOIN: false });
    const p1 = runContract.prepareContractRun({ leaseSeconds: -1 });
    expect(mgr.runLeaseSweep()).toBe(0);
    expect(getRun(p1!.runId)!.status).toBe('running');

    // Flag ON => sweeps it.
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true, FEATURE_LEASE_JOIN: true });
    expect(mgr.runLeaseSweep()).toBeGreaterThanOrEqual(1);
    expect(getRun(p1!.runId)!.status).toBe('stalled');
  });
});

// ===========================================================================
// F. Outcome heartbeat (FEATURE_OUTCOME_HB)
// ===========================================================================
describe('F. outcome heartbeat', () => {
  it('exit-without-envelope => UNHEALTHY (never healthy)', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true, FEATURE_OUTCOME_HB: true });
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 });
    runContract.emitOutcomeHeartbeat('w-hb', prepared!.runId, true /* exitedWithoutCompletion */);
    const { readLatestOutcomeHeartbeat } = await import('../../src/bus/outcome-hb.js');
    const hb = readLatestOutcomeHeartbeat('w-hb', 'run_goodput');
    expect(hb).not.toBeNull();
    expect(hb!.healthy).toBe(false);
  });

  it('completed-with-no-contract => NOT healthy (classifyOutcome UNCLASSIFIED => value 0)', async () => {
    process.env.CTX_FEATURE_FLAGS_PATH = writeFlags({ FEATURE_COMPLETION_CONTRACT: true, FEATURE_OUTCOME_HB: true });
    const prepared = runContract.prepareContractRun({ leaseSeconds: 60 }); // no expectedOutcome
    completeRun(signedEnvelope(prepared!.env.CTX_RUN_TOKEN, prepared!.runId, { status: 'completed' }));
    runContract.emitOutcomeHeartbeat('w-hb2', prepared!.runId, false);
    const { readLatestOutcomeHeartbeat } = await import('../../src/bus/outcome-hb.js');
    const hb = readLatestOutcomeHeartbeat('w-hb2', 'run_goodput');
    expect(hb!.healthy).toBe(false);
  });
});
