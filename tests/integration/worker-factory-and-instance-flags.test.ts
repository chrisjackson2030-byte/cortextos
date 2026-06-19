/**
 * worker-factory-and-instance-flags.test.ts
 *
 * ITEM 5 (injected WorkerFactory, no env-var seam) + ITEM 6 (instance-scoped
 * feature flags for worker children). Drives the REAL spawn path: real
 * AgentManager.spawnWorker -> real WorkerProcess.spawn -> real AgentPTY ->
 * real node-pty spawn of a deterministic worker -> real child env (getBaseEnv
 * keeplist + extraEnv contract vars + instance-scoped CTX_FEATURE_FLAGS_PATH /
 * CTX_RUN_STORE_DB) -> real onExit / run-store completion handler.
 *
 * The deterministic worker command is supplied ONLY here via the injected
 * WorkerFactory. There is no production code path that selects it.
 *
 * Requires the repo to be BUILT (dist/cli.js) because the deterministic worker
 * uses the real `cortextos bus complete-run` CLI for IPC completion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

import { AgentManager } from '../../src/daemon/agent-manager.js';
import { IPCServer } from '../../src/daemon/ipc-server.js';
import { deterministicWorkerFactory } from '../helpers/test-worker-factory.js';

const REPO_ROOT = join(__dirname, '..', '..');
const PROD_FLAGS = '/Users/chrisjackson/cortextos/orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json';

function waitForFile(path: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${path}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function makeInstance(label: string) {
  const pid = process.pid;
  const instanceId = `jcv1seamb-${label.toLowerCase()}-${pid}`;
  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  mkdirSync(ctxRoot, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), `jcv1seamB-${label}-`));
  return { instanceId, ctxRoot, tmp };
}

const envBackup = { ...process.env };

afterAll(() => {
  process.env = { ...envBackup };
});

describe('ITEM 6 — instance-scoped feature flags for worker children', () => {
  it('worker A resolves COMPLETION_CONTRACT=true, worker B resolves false, neither reads production flags', async () => {
    // --- Instance A: COMPLETION_CONTRACT=true ---
    const A = makeInstance('A');
    const flagsA = join(A.tmp, 'feature-flags.json');
    writeFileSync(flagsA, JSON.stringify({ FEATURE_COMPLETION_CONTRACT: true }), 'utf-8');
    const probeA = join(A.tmp, 'probe.json');

    // --- Instance B: COMPLETION_CONTRACT=false ---
    const B = makeInstance('B');
    const flagsB = join(B.tmp, 'feature-flags.json');
    writeFileSync(flagsB, JSON.stringify({ FEATURE_COMPLETION_CONTRACT: false }), 'utf-8');
    const probeB = join(B.tmp, 'probe.json');

    // Sanity: the production flags file must NOT equal either instance file and
    // (if it exists) must not coincidentally read the same values.
    expect(flagsA).not.toEqual(PROD_FLAGS);
    expect(flagsB).not.toEqual(PROD_FLAGS);

    // ---- Spawn worker A under instance A's flags ----
    process.env.CTX_INSTANCE_ID = A.instanceId;
    process.env.CTX_FEATURE_FLAGS_PATH = flagsA; // the spawning daemon's instance flags
    delete process.env.CTX_RUN_STORE_DB;
    const mgrA = new AgentManager(A.instanceId, A.ctxRoot, REPO_ROOT, 'main');
    const factoryA = deterministicWorkerFactory(REPO_ROOT, probeA, ['FEATURE_COMPLETION_CONTRACT']);
    await mgrA.spawnWorker('det-A', A.tmp, 'noop', undefined, undefined, factoryA);
    await waitForFile(probeA);

    // ---- Spawn worker B under instance B's flags ----
    process.env.CTX_INSTANCE_ID = B.instanceId;
    process.env.CTX_FEATURE_FLAGS_PATH = flagsB;
    const mgrB = new AgentManager(B.instanceId, B.ctxRoot, REPO_ROOT, 'main');
    const factoryB = deterministicWorkerFactory(REPO_ROOT, probeB, ['FEATURE_COMPLETION_CONTRACT']);
    await mgrB.spawnWorker('det-B', B.tmp, 'noop', undefined, undefined, factoryB);
    await waitForFile(probeB);

    const resA = JSON.parse(readFileSync(probeA, 'utf-8'));
    const resB = JSON.parse(readFileSync(probeB, 'utf-8'));

    // Worker A saw instance A's flag path + value=true
    expect(resA.env_CTX_FEATURE_FLAGS_PATH).toBe(flagsA);
    expect(resA.resolvedFlagsPath).toBe(flagsA);
    expect(resA.readProductionDefault).toBe(false);
    expect(resA.resolvedFlags.FEATURE_COMPLETION_CONTRACT).toBe(true);

    // Worker B saw instance B's flag path + value=false
    expect(resB.env_CTX_FEATURE_FLAGS_PATH).toBe(flagsB);
    expect(resB.resolvedFlagsPath).toBe(flagsB);
    expect(resB.readProductionDefault).toBe(false);
    expect(resB.resolvedFlags.FEATURE_COMPLETION_CONTRACT).toBe(false);

    // NEITHER read the production flags file.
    expect(resA.resolvedFlagsPath).not.toBe(PROD_FLAGS);
    expect(resB.resolvedFlagsPath).not.toBe(PROD_FLAGS);

    // Expose the resolved values for the evidence file.
    writeFileSync(
      join(REPO_ROOT, 'tests', '.item6-result.json'),
      JSON.stringify({ A: resA, B: resB, flagsA, flagsB, PROD_FLAGS }, null, 2),
    );

    // cleanup throwaway ctxRoots' sockets dirs are left in place per instructions
    rmSync(A.tmp, { recursive: true, force: true });
    rmSync(B.tmp, { recursive: true, force: true });
  }, 30000);
});

describe('ITEM 5c — injected WorkerFactory drives real spawn + real IPC completion', () => {
  it('deterministic worker spawns via real path and completes its contract run via real IPC', async () => {
    const C = makeInstance('C');
    const flagsC = join(C.tmp, 'feature-flags.json');
    // FEATURE_COMPLETION_CONTRACT on so spawnWorker mints a run row + token and
    // the worker's complete-run is honored.
    writeFileSync(flagsC, JSON.stringify({ FEATURE_COMPLETION_CONTRACT: true }), 'utf-8');
    const probeC = join(C.tmp, 'probe.json');
    const runDb = join(C.tmp, 'runs.db');

    // The IPC server + AgentManager + the worker child must ALL resolve the same
    // run-store DB. The daemon process sets these in its own env; AgentPTY threads
    // them to the child.
    process.env.CTX_INSTANCE_ID = C.instanceId;
    process.env.CTX_FEATURE_FLAGS_PATH = flagsC;
    process.env.CTX_RUN_STORE_DB = runDb;

    const mgr = new AgentManager(C.instanceId, C.ctxRoot, REPO_ROOT, 'main');
    const ipc = new IPCServer(mgr, C.instanceId);
    await ipc.start(); // listens on ~/.cortextos/<instance>/daemon.sock

    try {
      const factory = deterministicWorkerFactory(REPO_ROOT, probeC, ['FEATURE_COMPLETION_CONTRACT']);
      // Real spawn path; FEATURE_COMPLETION_CONTRACT on => run row + token minted,
      // contract env injected into the child, prompt appended.
      await mgr.spawnWorker('det-C', C.tmp, 'noop', undefined, undefined, factory);
      await waitForFile(probeC);

      const res = JSON.parse(readFileSync(probeC, 'utf-8'));

      // The worker received a contract run id + the instance run-store db path.
      expect(res.env_CTX_RUN_ID).toBeTruthy();
      expect(res.env_CTX_RUN_STORE_DB).toBe(runDb);

      // The worker completed its run through the REAL CLI -> real IPC -> run-store.
      expect(res.completion).toBeTruthy();
      expect(res.completion.ok).toBe(true);

      // Verify the run row in the REAL run-store is now terminal/completed.
      const runStore = await import('../../src/bus/run-store.js');
      const row = runStore.getRun(res.env_CTX_RUN_ID);
      expect(row).toBeTruthy();
      expect(row!.status).toBe('completed');

      writeFileSync(
        join(REPO_ROOT, 'tests', '.item5c-result.json'),
        JSON.stringify({ probe: res, runRow: row }, null, 2),
      );
    } finally {
      ipc.stop();
      rmSync(C.tmp, { recursive: true, force: true });
    }
  }, 30000);
});
