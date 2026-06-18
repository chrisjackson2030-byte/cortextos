/**
 * run-contract.ts — daemon-side wiring for the completion-contract / lease
 * integration. All logic here is reached ONLY when the relevant feature flag is
 * enabled; the daemon's legacy spawn/exit path does not import or call any of
 * this when flags are off (the call sites in agent-manager / worker-process are
 * gated by isFeatureEnabled, default-false = legacy behavior).
 *
 * This module does NOT duplicate validation / state-transition / token / HMAC
 * logic — it calls the shared run-store (startRun, completeRun, verifyEnvelope,
 * validateEnvelope, attemptTransition, classifyOutcome, getRun, expireStaleRuns).
 */

import { getRun, startRun, classifyOutcome, setRunTraceIfUnset, COMPLETION_SCHEMA_VERSION } from '../bus/run-store.js';
import type { ExpectedOutcomeContract, RunRecord } from '../bus/run-store.js';
import { writeOutcomeHeartbeat } from '../bus/outcome-hb.js';
import { isFeatureEnabled } from '../utils/feature-flags.js';

/** Environment variables injected into a contract-managed worker process. */
export interface ContractEnv {
  CTX_RUN_ID: string;
  CTX_RUN_TOKEN: string; // raw token — process env ONLY, never logged/argv/prompt
  CTX_TRACE_ID: string;
  CTX_PARENT_RUN_ID: string;
  CTX_LEASE_DEADLINE: string;
  CTX_COMPLETION_SCHEMA_VERSION: string;
}

/** Result of preparing a contract run for a worker spawn. */
export interface PreparedContractRun {
  runId: string;
  traceId: string;
  /** Env vars to inject into the PTY. CTX_RUN_TOKEN carries the raw token. */
  env: ContractEnv;
  /** Immutable, machine-generated completion instruction to append to prompt. */
  instruction: string;
}

export interface PrepareContractOptions {
  parentRunId?: string;
  /** Parent trace id; propagated to the child when FEATURE_TRACE_ID is on. */
  traceId?: string;
  leaseSeconds?: number;
  expectedOutcome?: ExpectedOutcomeContract;
}

/**
 * The completion instruction appended to a contract-managed worker's task
 * prompt. Machine-generated + immutable: it tells the worker to complete via the
 * bus helper, which reads the token from CTX_RUN_TOKEN in its environment. The
 * raw token is NEVER placed in this text. The daemon does NOT depend on the
 * model obeying — if the worker never completes, the lease sweep resolves it.
 */
export function completionInstruction(runId: string): string {
  return [
    '',
    '---',
    '[COMPLETION CONTRACT — machine-generated, do not edit]',
    `This task runs under a completion contract (run ${runId}). When you finish,`,
    'you MUST report completion by running:',
    '  cortextos bus complete-run "$CTX_RUN_ID" "$CTX_RUN_TOKEN" --status completed --result "<one-line summary>"',
    'The run token is in your environment as CTX_RUN_TOKEN. Read it from the',
    'environment only — never print it, never paste it into a message, a file, or',
    'the prompt. If you cannot finish, complete with --status failed or --status',
    'blocked instead. A bare process exit without complete-run is NOT a success.',
    '---',
  ].join('\n');
}

/**
 * Prepare a contract run: mint the run row + token via the shared run-store,
 * then return the env vars + completion instruction for the spawner. The run row
 * is created (status=running) BEFORE the worker process is spawned. Returns null
 * if the run-store is unavailable (DB error) — the caller decides whether to
 * fall back to legacy spawn or fail; for spawn we proceed legacy (no contract).
 *
 * Caller MUST have already checked isFeatureEnabled('FEATURE_COMPLETION_CONTRACT').
 */
export function prepareContractRun(opts: PrepareContractOptions): PreparedContractRun | null {
  const traceEnabled = isFeatureEnabled('FEATURE_TRACE_ID');
  // When tracing is on, propagate the parent trace id to the child (child gets
  // its OWN run id from startRun, but shares the trace id). When off, the child
  // run still gets a trace id equal to its run id later, but we pass the parent
  // trace through only under the flag.
  const traceId = traceEnabled ? opts.traceId : undefined;

  const started = startRun({
    origin: 'daemon',
    parentRunId: opts.parentRunId,
    traceId,
    leaseSeconds: opts.leaseSeconds,
    expectedOutcome: opts.expectedOutcome,
  });
  if (!started) return null;

  // Child shares parent trace under FEATURE_TRACE_ID; otherwise its trace id is
  // its own run id (a self-rooted trace), so events are still correlatable.
  const effectiveTrace = started.trace_id ?? started.run_id;
  // Persist the self-rooted trace when startRun did not store one (no parent
  // trace propagated), so the run is retrievable by trace_id. Idempotent.
  if (!started.trace_id) {
    setRunTraceIfUnset(started.run_id, effectiveTrace);
  }

  const rec = getRun(started.run_id);
  const leaseDeadline = rec?.lease_expires_at ?? rec?.lease_deadline ?? '';

  const env: ContractEnv = {
    CTX_RUN_ID: started.run_id,
    CTX_RUN_TOKEN: started.run_token, // raw, ONCE — process env only
    CTX_TRACE_ID: effectiveTrace,
    CTX_PARENT_RUN_ID: opts.parentRunId ?? '',
    CTX_LEASE_DEADLINE: leaseDeadline,
    CTX_COMPLETION_SCHEMA_VERSION: String(COMPLETION_SCHEMA_VERSION),
  };

  return {
    runId: started.run_id,
    traceId: effectiveTrace,
    env,
    instruction: completionInstruction(started.run_id),
  };
}

/**
 * Redact any raw run token from a string before it reaches a log / diagnostic /
 * exception / event. Given the set of tokens currently in flight (the daemon
 * knows them because it minted them), replace each with a fixed marker. This is
 * defense-in-depth on top of "never pass the token to a logger in the first
 * place".
 */
export function redactTokens(text: string, tokens: Iterable<string>): string {
  let out = text;
  for (const t of tokens) {
    if (t && t.length >= 8) {
      out = out.split(t).join('[REDACTED_RUN_TOKEN]');
    }
  }
  return out;
}

/**
 * Decide whether a process exit should be treated as a legacy success or, under
 * the contract, deferred to the lease. Returns the worker status to set.
 *
 * Contract ON: if the run has a VALID recorded completion envelope (terminal
 * status reached via the IPC/run-store path), the worker is 'completed'/'failed'
 * per that envelope's recorded outcome; otherwise the bare exit is recorded as
 * 'exited_without_completion' and left for the lease sweep to resolve.
 *
 * Contract OFF: legacy — exit code 0 => completed, else failed.
 */
export function classifyWorkerExit(
  runId: string | undefined,
  exitCode: number,
): { status: 'completed' | 'failed' | 'exited_without_completion'; recordedTerminal: boolean } {
  if (!isFeatureEnabled('FEATURE_COMPLETION_CONTRACT') || !runId) {
    return { status: exitCode === 0 ? 'completed' : 'failed', recordedTerminal: false };
  }

  const rec = getRun(runId);
  if (rec && isTerminalCompletion(rec.status)) {
    // The run already reached a terminal state through the validated IPC path.
    // Mirror that into the worker status. 'completed'/'done' => completed;
    // 'failed'/'stalled'/'cancelled' => failed (not a success).
    const success = rec.status === 'completed' || rec.status === 'done';
    return { status: success ? 'completed' : 'failed', recordedTerminal: true };
  }

  // No valid completion envelope: a bare exit is NOT a success. Leave the run
  // running so the lease sweep can mark it stalled.
  return { status: 'exited_without_completion', recordedTerminal: false };
}

function isTerminalCompletion(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'done' ||
    status === 'failed' ||
    status === 'stalled' ||
    status === 'cancelled'
  );
}

/**
 * Emit an outcome heartbeat for a finished contract worker (FEATURE_OUTCOME_HB).
 * Reuses the existing writeOutcomeHeartbeat. A process-exit-without-envelope is
 * UNHEALTHY (value 0 < min 1, never healthy). A completed run's productivity is
 * derived from classifyOutcome (the shared classifier), so status=completed can
 * never auto-produce a healthy heartbeat without satisfying its expected-outcome
 * contract.
 *
 * Caller MUST have already checked isFeatureEnabled('FEATURE_OUTCOME_HB').
 */
export function emitOutcomeHeartbeat(
  agent: string,
  runId: string | undefined,
  exitedWithoutCompletion: boolean,
): void {
  if (exitedWithoutCompletion || !runId) {
    // Unhealthy: value 0, min 1.
    writeOutcomeHeartbeat(agent, 'run_goodput', 0, 1);
    return;
  }
  const rec = getRun(runId);
  if (!rec) {
    writeOutcomeHeartbeat(agent, 'run_goodput', 0, 1);
    return;
  }
  const klass = classifyOutcome(rec);
  // Map classification -> (value, min). Only PRODUCTIVE is healthy.
  const value = klass === 'PRODUCTIVE' ? 1 : 0;
  writeOutcomeHeartbeat(agent, 'run_goodput', value, 1);
}

export type { ExpectedOutcomeContract, RunRecord };
