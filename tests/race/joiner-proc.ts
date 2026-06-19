/**
 * Standalone parent-join PROCESS for the durable-run-events race harness.
 *
 * Run as its own node (tsx) process with its OWN db connection. It:
 *   1. signals readiness by creating <barrierDir>/ready-<id>
 *   2. spin-waits until <barrierDir>/GO exists (the barrier release)
 *   3. calls joinRun(childRunId) EXACTLY ONCE
 *   4. prints a single JSON line:
 *      { role:'joiner', id, status, run_id, error }
 *
 * Only the real run-store API is used; the run_events table is the only event
 * sink. CTX_RUN_STORE_DB selects the shared throwaway db.
 */
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { joinRun } from '../../src/bus/run-store';

function spinUntilGo(barrierDir: string): void {
  const go = join(barrierDir, 'GO');
  const deadline = Date.now() + 30000;
  while (!existsSync(go)) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
  }
}

function main(): void {
  const id = process.argv[2];
  const barrierDir = process.argv[3];
  const childRunId = process.argv[4];
  writeFileSync(join(barrierDir, `ready-joiner-${id}`), '1');
  spinUntilGo(barrierDir);
  let status: string | null = null;
  let runId: string | null = null;
  let error: string | null = null;
  try {
    const r = joinRun(childRunId);
    status = r ? r.status : null;
    runId = r ? r.run_id : null;
  } catch (err) {
    error = err instanceof Error ? `${err.message}` : String(err);
  }
  process.stdout.write(
    JSON.stringify({ role: 'joiner', id, status, run_id: runId, error }) + '\n',
  );
}

main();
