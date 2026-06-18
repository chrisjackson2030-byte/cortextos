import { join } from 'path';
import { mkdirSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';
import { isFeatureEnabled } from '../utils/feature-flags.js';
import { classifyWorkerExit, emitOutcomeHeartbeat } from './run-contract.js';

/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - No session timer (workers run until task is complete)
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 */
export class WorkerProcess {
  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;
  /**
   * Contract run id for this worker, when spawned under
   * FEATURE_COMPLETION_CONTRACT. Set from env.extraEnv.CTX_RUN_ID at spawn.
   * Undefined on the legacy path.
   */
  private runId: string | undefined;

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env: CtxEnv, prompt: string, config: { model?: string } = {}): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
    } catch { /* ignore */ }

    // Contract run id (if any) is carried in env.extraEnv.CTX_RUN_ID. The raw
    // token (CTX_RUN_TOKEN) is NEVER stored on the worker object or logged.
    this.runId = env.extraEnv?.CTX_RUN_ID;

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, config, logPath);

    this.pty.onExit((code) => {
      this.exitCode = code;

      // FEATURE_COMPLETION_CONTRACT: a bare process exit is an EVENT, not a
      // state transition. classifyWorkerExit checks the run-store for a valid
      // recorded completion envelope; with none, the worker is marked
      // 'exited_without_completion' (NOT 'completed') and the run is left for
      // the lease sweep to resolve. Flags-off => legacy (code 0 = completed).
      if (isFeatureEnabled('FEATURE_COMPLETION_CONTRACT') && this.runId) {
        const verdict = classifyWorkerExit(this.runId, code);
        this.status = verdict.status;
        if (verdict.status === 'exited_without_completion') {
          // Marker event: a process_exited_without_completion record. We log it
          // (no token in the line) so the bare exit is traceable; the lease
          // sweep produces the terminal 'stalled' state.
          this.log(
            `process_exited_without_completion (code ${code}, run ${this.runId}) — leaving run for lease sweep`,
          );
        } else {
          this.log(`Exited with code ${code} → ${this.status} (run ${this.runId})`);
        }
        // Outcome heartbeat (FEATURE_OUTCOME_HB): exit-without-envelope => UNHEALTHY;
        // a completed run's productivity is derived from classifyOutcome (never
        // auto-healthy on bare status=completed).
        if (isFeatureEnabled('FEATURE_OUTCOME_HB')) {
          try {
            emitOutcomeHeartbeat(
              this.name,
              this.runId,
              verdict.status === 'exited_without_completion',
            );
          } catch { /* outcome hb must never block exit handling */ }
        }
      } else {
        // Legacy path: exit code 0 => completed, else failed.
        this.status = code === 0 ? 'completed' : 'failed';
        this.log(`Exited with code ${code} → ${this.status}`);
      }

      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });

    await this.pty.spawn('fresh', prompt);
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    if (!this.pty) return;
    this.log('Terminating...');
    try {
      this.pty.write('\x03'); // Ctrl-C
      await sleep(500);
      this.pty.kill();
    } catch { /* ignore */ }
    this.status = 'completed';
    this.pty = null;
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty?.write(data), text);
    return true;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
    };
  }

  isFinished(): boolean {
    return (
      this.status === 'completed' ||
      this.status === 'failed' ||
      this.status === 'exited_without_completion'
    );
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
