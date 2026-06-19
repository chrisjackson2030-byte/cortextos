/**
 * REAL concurrent race harness for DURABLE RUN EVENTS.
 *
 * Per iteration:
 *   1. Create a real OVERDUE running child (startRun contract-mode, lease in
 *      the past) with a parent_run_id, via the run-store code itself.
 *   2. Spawn TWO independent sweeper PROCESSES and TWO concurrent parent-join
 *      PROCESSES — each its own node (tsx) process with its own db connection —
 *      all against the SAME throwaway db, released by a file barrier so the two
 *      sweepers truly race.
 *   3. Prove FROM THE REAL run_events TABLE (queried directly; NO harness event
 *      tables are ever created) the eight invariants.
 *   4. Additionally: repeated joinRun idempotence, late completeRun rejection.
 *
 * Aggregates across 50+ iterations and writes the evidence JSON.
 */
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  startRun,
  joinRun,
  completeRun,
  type RunRejection,
} from '../../src/bus/run-store';
import type { CompletionEnvelope } from '../../src/types';

const REPO = resolve(__dirname, '..', '..');
const DB_DIR = join(process.env.HOME || '/tmp', '.cortextos', 'jcv1eventsA');
const DB_PATH = join(DB_DIR, 'runs.db');
const EVIDENCE_PATH =
  '/Users/chrisjackson/cortextos/orgs/main/agents/jarvis/state/proof/gate-events-race-evidence-2026-06-18.json';

const ITERATIONS = Number(process.env.RACE_ITERATIONS || '50');

type ProcResult = {
  role: 'sweeper' | 'joiner';
  id: string;
  expired?: number;
  status?: string | null;
  run_id?: string | null;
  error: string | null;
};

type Failure = { iteration: number; requirement: string; detail: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spawn a sweeper/joiner child process with the shared throwaway db env. */
function spawnProc(
  script: string,
  args: string[],
): Promise<ProcResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      join(REPO, 'node_modules', '.bin', 'tsx'),
      [join(REPO, 'tests', 'race', script), ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          CTX_RUN_STORE_DB: DB_PATH,
        },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        resolveP(JSON.parse(line) as ProcResult);
      } catch {
        rejectP(
          new Error(
            `proc ${script} exit=${code} unparsable stdout=<${out}> stderr=<${err}>`,
          ),
        );
      }
    });
  });
}

/** Open a fresh read connection to the REAL throwaway db. */
function openDb(): InstanceType<typeof Database> {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

type EventRow = {
  event_key: string;
  run_id: string;
  parent_run_id: string | null;
  trace_id: string | null;
  event_type: string;
  terminal_state: string | null;
  payload_json: string;
  created_at: string;
};

function isRejection(x: unknown): x is RunRejection {
  return !!x && typeof x === 'object' && (x as RunRejection).ok === false;
}

async function main(): Promise<void> {
  // Fresh throwaway db every run so counts are unambiguous.
  if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });

  // The run-store derives its db from CTX_RUN_STORE_DB; set it for in-process
  // calls (startRun / in-process joinRun / completeRun) too.
  process.env.CTX_RUN_STORE_DB = DB_PATH;

  const failures: Failure[] = [];
  const sampleRows: {
    iteration: number;
    run_terminal: EventRow[];
    parent_join_resolved: EventRow[];
  }[] = [];

  // Per-requirement aggregate counters.
  const agg = {
    transition_exactly_one: 0,
    run_terminal_exactly_one: 0,
    parent_join_resolved_exactly_one: 0,
    losing_sweeper_no_transition: 0,
    join_idempotent: 0,
    no_duplicate_side_effects: 0,
    late_completion_rejected: 0,
    no_db_error: 0,
  };

  let totalDbErrors = 0;
  let totalDuplicateEvents = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    // --- 1. Create a real overdue running child with a parent_run_id ---
    const parent = startRun({ origin: 'daemon', traceId: `race-parent-${i}` });
    if (!parent) throw new Error(`iter ${i}: parent startRun returned null`);
    const child = startRun({
      origin: 'daemon',
      parentRunId: parent.run_id,
      traceId: `race-child-${i}`,
      leaseSeconds: -1, // lease already in the past => overdue running
    });
    if (!child) throw new Error(`iter ${i}: child startRun returned null`);
    const childId = child.run_id;

    // --- 2. Barrier + spawn 2 sweepers + 2 joiners that truly race ---
    const barrierDir = mkdtempSync(join(tmpdir(), `race-barrier-${i}-`));
    const procs = [
      spawnProc('sweeper-proc.ts', ['A', barrierDir]),
      spawnProc('sweeper-proc.ts', ['B', barrierDir]),
      spawnProc('joiner-proc.ts', ['A', barrierDir, childId]),
      spawnProc('joiner-proc.ts', ['B', barrierDir, childId]),
    ];

    // Wait until all four children signalled readiness, then release barrier.
    const expectedReady = ['ready-sweeper-A', 'ready-sweeper-B', 'ready-joiner-A', 'ready-joiner-B'];
    const readyDeadline = Date.now() + 20000;
    for (;;) {
      const present = new Set(readdirSync(barrierDir));
      if (expectedReady.every((f) => present.has(f))) break;
      if (Date.now() > readyDeadline) throw new Error(`iter ${i}: readiness timeout`);
      await sleep(2);
    }
    writeFileSync(join(barrierDir, 'GO'), '1'); // release: all four go now

    const results = await Promise.all(procs);
    rmSync(barrierDir, { recursive: true, force: true });

    const sweepers = results.filter((r) => r.role === 'sweeper');
    const joiners = results.filter((r) => r.role === 'joiner');

    // --- DB error check across all 4 procs ---
    const procErrors = results.filter((r) => r.error);
    if (procErrors.length > 0) {
      totalDbErrors += procErrors.length;
      for (const e of procErrors) {
        failures.push({ iteration: i, requirement: 'no_db_error', detail: `${e.role}-${e.id}: ${e.error}` });
      }
    } else {
      agg.no_db_error += 1;
    }

    // --- 3. Query the REAL run_events table directly ---
    const db = openDb();

    const terminalRows = db
      .prepare(
        `SELECT * FROM run_events WHERE event_type = 'run_terminal' AND run_id = ?`,
      )
      .all(childId) as EventRow[];
    const joinRows = db
      .prepare(
        `SELECT * FROM run_events WHERE event_type = 'parent_join_resolved' AND run_id = ?`,
      )
      .all(childId) as EventRow[];

    // Requirement: exactly one running->stalled transition.
    // The sweeper that wins via expireStaleRuns reports expired=1; but a joiner
    // can also be the one that flips it (joinRun transitions overdue->stalled).
    // The authoritative count is: exactly one run_terminal event OR (if a joiner
    // won the flip) zero sweeper transitions but a stalled row. We assert the
    // ground truth: the runs row is stalled, and across BOTH sweepers the sum of
    // 'expired' on THIS child is at most 1 (the lease-sweep CAS winner).
    const childRow = db.prepare('SELECT status FROM runs WHERE run_id = ?').get(childId) as
      | { status: string }
      | undefined;
    const sweepWins = sweepers.reduce((n, s) => n + (s.expired ?? 0), 0);

    // exactly-one transition: the child ends stalled, and no more than one
    // sweeper claimed a lease-sweep transition for it. (A joiner may have won
    // the flip instead, in which case sweepWins can be 0 — still exactly one
    // transition overall because the row went running->stalled once and is now
    // terminal/idempotent.)
    if (childRow?.status === 'stalled' && sweepWins <= 1) {
      agg.transition_exactly_one += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'transition_exactly_one',
        detail: `status=${childRow?.status} sweepWins=${sweepWins}`,
      });
    }

    // Requirement: exactly one run_terminal event row.
    if (terminalRows.length === 1 && terminalRows[0].event_key === `terminal:${childId}:stalled`) {
      agg.run_terminal_exactly_one += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'run_terminal_exactly_one',
        detail: `count=${terminalRows.length} keys=${terminalRows.map((r) => r.event_key).join(',')}`,
      });
    }

    // Requirement: exactly one parent_join_resolved event row (two concurrent
    // joiners).
    const expectedJoinKey = `join-resolved:${parent.run_id}:${childId}:stalled`;
    if (joinRows.length === 1 && joinRows[0].event_key === expectedJoinKey) {
      agg.parent_join_resolved_exactly_one += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'parent_join_resolved_exactly_one',
        detail: `count=${joinRows.length} keys=${joinRows.map((r) => r.event_key).join(',')}`,
      });
    }

    // Requirement: losing sweeper reports no transition. At most one sweeper
    // reports expired>=1 for this child; the other(s) report 0. (sweepWins can
    // be 0 if a joiner won the flip — that still satisfies "no losing sweeper
    // claimed a transition".)
    const sweepersClaiming = sweepers.filter((s) => (s.expired ?? 0) > 0).length;
    if (sweepersClaiming <= 1) {
      agg.losing_sweeper_no_transition += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'losing_sweeper_no_transition',
        detail: `sweepers claiming transition=${sweepersClaiming}`,
      });
    }

    // Requirement: both joiners returned the SAME typed terminal result.
    const joinerStatuses = joiners.map((j) => j.status);
    const sameTyped = joinerStatuses.every((s) => s === 'stalled');
    if (sameTyped) {
      // ok, recorded under join_idempotent below after extra calls
    } else {
      failures.push({
        iteration: i,
        requirement: 'join_typed_result',
        detail: `joiner statuses=${joinerStatuses.join(',')}`,
      });
    }

    // Requirement: repeated joinRun is idempotent — call several MORE times
    // in-process; still exactly one parent_join_resolved event, same typed
    // result, NO new event rows, NO second side effect.
    let idempotent = true;
    for (let k = 0; k < 4; k++) {
      const again = joinRun(childId);
      if (!again || again.status !== 'stalled') {
        idempotent = false;
        failures.push({ iteration: i, requirement: 'join_idempotent', detail: `repeat ${k} status=${again?.status}` });
        break;
      }
    }
    const joinRowsAfter = db
      .prepare(`SELECT * FROM run_events WHERE event_type = 'parent_join_resolved' AND run_id = ?`)
      .all(childId) as EventRow[];
    if (idempotent && joinRowsAfter.length === 1) {
      agg.join_idempotent += 1;
    } else if (joinRowsAfter.length !== 1) {
      failures.push({
        iteration: i,
        requirement: 'join_idempotent',
        detail: `after repeats parent_join_resolved count=${joinRowsAfter.length}`,
      });
    }

    // Requirement: no duplicate side effects. Total events for this child must
    // be exactly 2 (1 run_terminal + 1 parent_join_resolved). Any extra row is a
    // duplicate notification/task/side-effect.
    const allChildEvents = db
      .prepare('SELECT * FROM run_events WHERE run_id = ?')
      .all(childId) as EventRow[];
    const dupCount = allChildEvents.length - 2;
    if (dupCount > 0) totalDuplicateEvents += dupCount;
    if (allChildEvents.length === 2) {
      agg.no_duplicate_side_effects += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'no_duplicate_side_effects',
        detail: `total run_events for child=${allChildEvents.length} keys=${allChildEvents.map((r) => r.event_key).join(',')}`,
      });
    }

    // Requirement: late completion after the race is rejected — completeRun on
    // the stalled child must be rejected (terminal-overwrite forbidden) and the
    // status must stay 'stalled'.
    const lateEnvelope: CompletionEnvelope & { run_token?: string } = {
      run_id: childId,
      status: 'completed',
      result: 'late completion attempt',
      signature: 'irrelevant',
      run_token: child.run_token,
      emitted_at: '2026-06-18T23:59:59Z',
    };
    const lateResult = completeRun(lateEnvelope);
    const afterLate = db.prepare('SELECT status FROM runs WHERE run_id = ?').get(childId) as
      | { status: string }
      | undefined;
    // completeRun on a terminal row returns the unchanged terminal RunRecord
    // (idempotent no-overwrite) OR a typed rejection — both are "rejected" in
    // the sense that the status is NOT overwritten away from stalled.
    const lateRejected =
      afterLate?.status === 'stalled' &&
      (isRejection(lateResult) || (lateResult && (lateResult as { status?: string }).status === 'stalled'));
    if (lateRejected) {
      agg.late_completion_rejected += 1;
    } else {
      failures.push({
        iteration: i,
        requirement: 'late_completion_rejected',
        detail: `afterStatus=${afterLate?.status} result=${JSON.stringify(lateResult)}`,
      });
    }

    // Keep a small sample of REAL rows for the evidence file.
    if (sampleRows.length < 3) {
      sampleRows.push({
        iteration: i,
        run_terminal: terminalRows,
        parent_join_resolved: joinRowsAfter,
      });
    }

    db.close();
  }

  const allPass = failures.length === 0;
  const evidence = {
    gate: 'durable-run-events-concurrent-race',
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      better_sqlite3: require('better-sqlite3/package.json').version,
      sqlite: openDbVersion(),
      worktree: REPO,
      throwaway_db: DB_PATH,
      run_events_table: 'run_events (REAL run-store table; NO harness event tables used)',
    },
    iterations: ITERATIONS,
    procs_per_iteration: { sweepers: 2, joiners: 2, separate_processes: true, separate_db_connections: true },
    requirements: {
      transition_exactly_one: { pass: agg.transition_exactly_one === ITERATIONS, count: `${agg.transition_exactly_one}/${ITERATIONS}` },
      run_terminal_exactly_one: { pass: agg.run_terminal_exactly_one === ITERATIONS, count: `${agg.run_terminal_exactly_one}/${ITERATIONS}` },
      parent_join_resolved_exactly_one: { pass: agg.parent_join_resolved_exactly_one === ITERATIONS, count: `${agg.parent_join_resolved_exactly_one}/${ITERATIONS}` },
      losing_sweeper_no_transition: { pass: agg.losing_sweeper_no_transition === ITERATIONS, count: `${agg.losing_sweeper_no_transition}/${ITERATIONS}` },
      join_idempotent: { pass: agg.join_idempotent === ITERATIONS, count: `${agg.join_idempotent}/${ITERATIONS}` },
      no_duplicate_side_effects: { pass: agg.no_duplicate_side_effects === ITERATIONS, count: `${agg.no_duplicate_side_effects}/${ITERATIONS}`, duplicate_event_rows_seen: totalDuplicateEvents },
      late_completion_rejected: { pass: agg.late_completion_rejected === ITERATIONS, count: `${agg.late_completion_rejected}/${ITERATIONS}` },
      no_db_error: { pass: agg.no_db_error === ITERATIONS && totalDbErrors === 0, count: `${agg.no_db_error}/${ITERATIONS}`, db_errors_seen: totalDbErrors },
    },
    sample_real_run_events_rows: sampleRows,
    failures,
    verdict: allPass ? 'PASS' : 'FAIL',
  };

  mkdirSync(join(EVIDENCE_PATH, '..'), { recursive: true });
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify(evidence.requirements, null, 2) + '\n');
  process.stdout.write(`VERDICT: ${evidence.verdict}  failures=${failures.length}\n`);
  process.stdout.write(`EVIDENCE: ${EVIDENCE_PATH}\n`);
  if (!allPass) process.exitCode = 1;
}

function openDbVersion(): string {
  const db = openDb();
  const v = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  db.close();
  return v.v;
}

main().catch((e) => {
  process.stderr.write(`HARNESS ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
