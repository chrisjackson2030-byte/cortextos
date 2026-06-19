/**
 * test-worker-factory.ts — TEST-ONLY injected WorkerFactory.
 *
 * This module lives under tests/ and is imported ONLY by tests. It is never in
 * the production daemon import graph (src/daemon/index.ts -> dist/daemon.js does
 * not reference it), so the deterministic worker command cannot be activated in
 * production by any env var or config — it must be explicitly constructed and
 * injected by a test harness via AgentManager.spawnWorker(..., factory) /
 * new WorkerProcess(..., factory).
 *
 * The factory replaces ONLY the spawned command (file + args). The rest of the
 * real spawn path runs unchanged: AgentPTY builds the full child env (getBaseEnv
 * keeplist + extraEnv contract vars + instance-scoped CTX_FEATURE_FLAGS_PATH /
 * CTX_RUN_STORE_DB), node-pty spawns the deterministic process with that env,
 * onData/onExit fire, and WorkerProcess runs its real run-store completion
 * handler. The deterministic worker reads its OWN process env to prove the
 * instance-scoped vars reached the child, and (optionally) completes its
 * contract run through the REAL run-store using the injected CTX_RUN_TOKEN.
 */
import { join } from 'path';
import type { WorkerFactory } from '../../src/pty/agent-pty.js';

/**
 * A deterministic worker that:
 *  - writes its resolved CTX_FEATURE_FLAGS_PATH / CTX_RUN_STORE_DB / CTX_RUN_ID
 *    and the actual feature-flag values it reads (via the real isFeatureEnabled,
 *    which honors the instance-scoped CTX_FEATURE_FLAGS_PATH) to a probe file;
 *  - if a contract run token is present, completes its run through the REAL
 *    run-store (signing a valid envelope with the injected raw token);
 *  - exits 0.
 *
 * @param repoRoot absolute path to the built repo (so the worker can require the
 *                 compiled dist modules — real run-store + real feature-flags).
 * @param probePath absolute path the worker writes its observed env+flags JSON to.
 * @param flagsToProbe feature-flag names whose resolved boolean values to record.
 */
export function deterministicWorkerFactory(
  repoRoot: string,
  probePath: string,
  flagsToProbe: string[],
): WorkerFactory {
  // Inline node program run as the deterministic worker. It re-implements the
  // EXACT flag resolution of src/utils/feature-flags.ts (honor
  // CTX_FEATURE_FLAGS_PATH, else production default) so the recorded values are
  // precisely what the worker's own complete-run would resolve, and it completes
  // any contract run through the REAL `cortextos bus complete-run` CLI (which is
  // the production completion channel: CLI -> IPC -> run-store).
  const program = `
    const fs = require('fs');
    const path = require('path');
    const repoRoot = ${JSON.stringify(repoRoot)};
    const probePath = ${JSON.stringify(probePath)};
    const flagsToProbe = ${JSON.stringify(flagsToProbe)};

    // Resolve flags EXACTLY as src/utils/feature-flags.ts does: honor
    // CTX_FEATURE_FLAGS_PATH override, else fall back to the production default.
    const PROD_DEFAULT = '/Users/chrisjackson/cortextos/orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json';
    function flagsPath() {
      const o = process.env.CTX_FEATURE_FLAGS_PATH;
      return o && o.trim() ? o : PROD_DEFAULT;
    }
    function isEnabled(flag) {
      try {
        const f = JSON.parse(fs.readFileSync(flagsPath(), 'utf-8'));
        return f[flag] === true;
      } catch { return false; }
    }
    const resolvedFlags = {};
    for (const fl of flagsToProbe) resolvedFlags[fl] = isEnabled(fl);

    const probe = {
      env_CTX_FEATURE_FLAGS_PATH: process.env.CTX_FEATURE_FLAGS_PATH || null,
      env_CTX_RUN_STORE_DB: process.env.CTX_RUN_STORE_DB || null,
      env_CTX_RUN_ID: process.env.CTX_RUN_ID || null,
      resolvedFlagsPath: flagsPath(),
      readProductionDefault: flagsPath() === PROD_DEFAULT,
      resolvedFlags,
    };

    // If a contract run is in play, complete it through the REAL run-store so
    // the parent's onExit -> classifyWorkerExit observes a recorded completion.
    let completion = null;
    const runId = process.env.CTX_RUN_ID;
    const runToken = process.env.CTX_RUN_TOKEN;
    if (runId && runToken) {
      try {
        // The worker completes through the REAL CLI: cortextos bus complete-run.
        // That CLI signs the envelope with CTX_RUN_TOKEN and routes daemon-origin
        // runs over the instance IPC socket (CTX_INSTANCE_ID) to the run-store.
        const { execFileSync } = require('child_process');
        // The worker uses the REAL CLI: cortextos bus complete-run, which itself
        // resolves CTX_RUN_STORE_DB from its env (the instance db). This is the
        // exact production completion channel.
        const out = execFileSync(process.execPath, [
          path.join(repoRoot, 'dist', 'cli.js'),
          'bus', 'complete-run', runId, runToken,
          '--status', 'completed',
          '--result', 'deterministic worker ok',
        ], { env: process.env, encoding: 'utf-8' });
        completion = { ok: true, out: String(out).slice(0, 400) };
      } catch (e) {
        completion = { ok: false, err: String(e && e.message ? e.message : e).slice(0, 400) };
      }
    }
    probe.completion = completion;
    fs.writeFileSync(probePath, JSON.stringify(probe, null, 2));
    process.stdout.write('DETERMINISTIC_WORKER_DONE\\n');
    process.exit(0);
  `;
  return () => ({ cmd: process.execPath, args: ['-e', program] });
}
