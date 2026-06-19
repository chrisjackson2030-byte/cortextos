/**
 * Standalone sweeper PROCESS for the durable-run-events race harness.
 *
 * Run as its own node (tsx) process with its OWN db connection. It:
 *   1. signals readiness by creating <barrierDir>/ready-<id>
 *   2. spin-waits until <barrierDir>/GO exists (the barrier release)
 *   3. calls expireStaleRuns() EXACTLY ONCE
 *   4. prints a single JSON line: { role:'sweeper', id, expired, error }
 *
 * No harness event tables are touched. The real run-store run_events table is
 * the only event sink. CTX_RUN_STORE_DB selects the shared throwaway db.
 */
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { expireStaleRuns } from '../../src/bus/run-store';

function spinUntilGo(barrierDir: string): void {
  const go = join(barrierDir, 'GO');
  // Busy spin keeps the race window tight (no timer slop).
  // Bounded so a stuck harness can never hang forever.
  const deadline = Date.now() + 30000;
  while (!existsSync(go)) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
  }
}

function main(): void {
  const id = process.argv[2];
  const barrierDir = process.argv[3];
  writeFileSync(join(barrierDir, `ready-sweeper-${id}`), '1');
  spinUntilGo(barrierDir);
  let expired = 0;
  let error: string | null = null;
  try {
    expired = expireStaleRuns();
  } catch (err) {
    error = err instanceof Error ? `${err.message}` : String(err);
  }
  process.stdout.write(JSON.stringify({ role: 'sweeper', id, expired, error }) + '\n');
}

main();
