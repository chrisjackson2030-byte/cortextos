import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import { isFeatureEnabled } from '../utils/feature-flags.js';

// node-pty types
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

/**
 * WorkerFactory — an injectable override for the command/args the PTY spawns.
 *
 * PRODUCTION: never set. AgentPTY falls back to its real claude command
 * (getBinaryName() + buildClaudeArgs()) and the production daemon never
 * constructs an AgentPTY with a factory. There is NO env-var-selectable test
 * path: the command an agent/worker runs cannot be replaced via process.env.
 *
 * TESTS ONLY: a test harness (under tests/) may pass a factory that returns a
 * deterministic worker command (e.g. a node one-liner). The factory replaces
 * ONLY the file+args; the rest of the spawn path — node-pty spawn, child env
 * construction, getBaseEnv keeplist, extraEnv injection, onData/onExit, the
 * WorkerProcess IPC + run-store completion handler — is exercised unchanged.
 */
export interface WorkerCommand {
  /** Executable to spawn (absolute path or PATH-resolvable name). */
  cmd: string;
  /** Argument vector passed to the executable. */
  args: string[];
}
export type WorkerFactory = (mode: 'fresh' | 'continue', prompt: string) => WorkerCommand;

/**
 * Manages a single Claude Code PTY session.
 * Replaces the tmux session management in agent-wrapper.sh.
 */
export class AgentPTY {
  private pty: IPty | null = null;
  private _alive = false;
  private outputBuffer: OutputBuffer;
  private env: CtxEnv;
  private config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;
  /**
   * Optional test-only override for the spawned command. Null in production
   * (the daemon never sets it). When present, supplies the file+args in place of
   * the real claude command; every other part of the spawn path is unchanged.
   */
  private workerFactory: WorkerFactory | null = null;

  constructor(
    env: CtxEnv,
    config: AgentConfig,
    logPath?: string,
    bootstrapPattern?: string,
    workerFactory?: WorkerFactory | null,
  ) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, bootstrapPattern);
    this.workerFactory = workerFactory ?? null;
  }

  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }

    // Lazy-load node-pty (native addon)
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }

    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();

    // Build environment variables for the PTY process
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Source org-level shared secrets (orgs/{org}/secrets.env).
    // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
    // Agent .env is loaded after and overrides org values — agent-specific keys win.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      if (existsSync(orgEnvFile)) {
        const content = readFileSync(orgEnvFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    }

    // Source agent .env file (overrides org secrets.env for same key names).
    // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
    const agentEnvFile = join(this.env.agentDir, '.env');
    if (existsSync(agentEnvFile)) {
      const content = readFileSync(agentEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    // Prevent Claude Code from silently upgrading to the 1M context window
    // (which caused unexpected billing in CC v2.1.51/v2.1.112 on Max plans).
    ptyEnv['CLAUDE_CODE_DISABLE_1M_CONTEXT'] = '1';

    // Completion-contract env injection (FEATURE_COMPLETION_CONTRACT). The
    // daemon populates env.extraEnv with the contract vars (CTX_RUN_ID /
    // CTX_RUN_TOKEN / CTX_TRACE_ID / CTX_PARENT_RUN_ID / CTX_LEASE_DEADLINE /
    // CTX_COMPLETION_SCHEMA_VERSION). It is undefined on the legacy path, so
    // this is a no-op when the flag is off. The raw run token reaches the worker
    // ONLY through this process-env channel — never via argv/prompt/logs.
    if (this.env.extraEnv) {
      for (const [k, v] of Object.entries(this.env.extraEnv)) {
        ptyEnv[k] = v;
      }
    }

    // INSTANCE-SCOPED FLAG + RUN-STORE RESOLUTION (item 6).
    //
    // The clean-env keeplist (getBaseEnv) intentionally drops CTX_* vars, so a
    // child PTY — and any `cortextos bus complete-run` subprocess it launches —
    // would otherwise resolve feature flags and the run-store DB from the
    // hardcoded PRODUCTION default path, NOT from the instance that spawned it.
    // That makes a worker on a non-default instance read the wrong flags (e.g.
    // it would see FEATURE_COMPLETION_CONTRACT from the production file instead
    // of its own instance), breaking instance isolation.
    //
    // Fix: thread the spawning daemon's own CTX_FEATURE_FLAGS_PATH and
    // CTX_RUN_STORE_DB into the child env so the worker resolves the SAME
    // instance's flags + run-store as the daemon. The daemon derives these from
    // its CTX_INSTANCE_ID at boot. In the default/production instance these vars
    // are typically unset, so the child falls back to the default path — which
    // is the correct default behavior (byte-identical to before).
    if (process.env.CTX_FEATURE_FLAGS_PATH) {
      ptyEnv['CTX_FEATURE_FLAGS_PATH'] = process.env.CTX_FEATURE_FLAGS_PATH;
    }
    if (process.env.CTX_RUN_STORE_DB) {
      ptyEnv['CTX_RUN_STORE_DB'] = process.env.CTX_RUN_STORE_DB;
    }

    // Add convenience CTX_* aliases used throughout agent templates.
    // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv['CTX_TIMEZONE'] = configTimezone;
      ptyEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }
    // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    // Spawn the agent binary directly (no shell wrapper) — cross-platform, no shell escaping needed.
    // env is passed natively via node-pty options; no bash export commands required.
    // On Windows, npm global installs create .cmd wrappers, not .exe binaries.
    // node-pty's CreateProcess requires the exact wrapper name to resolve correctly.
    // Resolve the command to spawn. PRODUCTION: workerFactory is null, so this
    // is the real claude command (getBinaryName + buildClaudeArgs), unchanged.
    // TEST-ONLY: an injected factory supplies a deterministic command; the
    // sandbox/env/onData/onExit path below is identical in both cases.
    const claudeArgs = this.workerFactory
      ? this.workerFactory(mode, prompt).args
      : this.buildClaudeArgs(mode, prompt);
    let claudeCmd = this.workerFactory
      ? this.workerFactory(mode, prompt).cmd
      : this.getBinaryName();

    // SANDBOX CANARY wrapping — macOS only, gated by FEATURE_SANDBOX_CANARY.
    //
    // Activation requires ALL THREE: a sandbox_profile, darwin, AND the
    // FEATURE_SANDBOX_CANARY flag enabled. The flag is the master kill-switch:
    // when it is false (default), NO agent is sandbox-wrapped regardless of its
    // sandbox_profile, so production behaviour is byte-identical until the
    // orchestrator activates the flag after review.
    //
    // Canary scope (one low-risk agent, NOT fleet-wide): once the flag is on,
    // only agents marked sandbox_canary=true in their config are wrapped. An
    // agent that carries a sandbox_profile but NOT sandbox_canary stays
    // unsandboxed, so flipping the flag cannot accidentally sandbox the fleet.
    const canaryActive =
      isFeatureEnabled('FEATURE_SANDBOX_CANARY') &&
      this.config.sandbox_canary === true;
    if (this.config.sandbox_profile && canaryActive && platform() === 'darwin') {
      const agentDir = join(
        this.env.projectRoot ?? '',
        'orgs', this.env.org ?? '', 'agents', this.env.agentName ?? ''
      );
      const claudeProjHash = agentDir.replace(/\//g, '-').replace(/^-/, '');
      const claudeProjDir = join(
        process.env.HOME ?? '',
        '.claude', 'projects', claudeProjHash
      );
      const orgDir = join(this.env.projectRoot ?? '', 'orgs', this.env.org ?? '');
      const ctxRoot = this.env.ctxRoot ?? '';
      const daemonSock = join(ctxRoot, 'daemon.sock');

      const SENTINEL = '/nonexistent-sandbox-placeholder';
      const agentsDir = join(orgDir, 'agents');
      const siblingDirs: string[] = [];
      try {
        const allAgents = readdirSync(agentsDir);
        for (const a of allAgents) {
          if (a !== this.env.agentName) {
            siblingDirs.push(join(agentsDir, a));
          }
        }
      } catch { /* proceed without sibling denies if agents dir unreadable */ }
      while (siblingDirs.length < 4) siblingDirs.push(SENTINEL);

      const sandboxParams = [
        '-D', `AGENT_DIR=${agentDir}`,
        '-D', `CTX_ROOT=${ctxRoot}`,
        '-D', `HOME_DIR=${process.env.HOME ?? ''}`,
        '-D', `CLAUDE_PROJ_DIR=${claudeProjDir}`,
        '-D', `DAEMON_SOCK=${daemonSock}`,
        '-D', `DENY_AGENT_1=${siblingDirs[0]}`,
        '-D', `DENY_AGENT_2=${siblingDirs[1]}`,
        '-D', `DENY_AGENT_3=${siblingDirs[2]}`,
        '-D', `DENY_AGENT_4=${siblingDirs[3]}`,
        // FAKE_CANARY_DIR: deny-read path for the planted fake canary secret.
        // Production launches default to the sentinel (no real path denied);
        // the credential red-team test overrides it with the planted dir.
        '-D', `FAKE_CANARY_DIR=${process.env.CTX_FAKE_CANARY_DIR ?? SENTINEL}`,
      ];

      this.pty = this.spawnFn!('sandbox-exec', [
        '-f', this.config.sandbox_profile,
        ...sandboxParams,
        claudeCmd,
        ...claudeArgs,
      ], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd,
        env: ptyEnv,
      });
    } else {
      this.pty = this.spawnFn!(claudeCmd, claudeArgs, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd,
        env: ptyEnv,
      });
    }

    this._alive = true;

    // Track which interactive prompts we've already responded to.
    let bypassAccepted = false;
    let trustAccepted = false;

    // Set up output capture + inline prompt detection.
    //
    // IMPORTANT: Raw PTY data contains ANSI escape codes between words, so multi-word
    // substring matching ("Bypass Permissions", "No, exit") fails silently.
    // Use single-word substrings that are never split by ANSI codes.
    //
    // Prompts handled:
    //   1. Bypass Permissions warning (CC 2.1+) — identified by raw "Bypass" in data.
    //      Default selection is "No, exit". Send down-arrow (move to "Yes, I accept")
    //      then Enter. bypassAccepted is set SYNCHRONOUSLY before any setTimeout so
    //      the trust handler below cannot fire on the same data chunk.
    //   2. "trust this folder?" prompt — identified by "trust" (only fires if no bypass
    //      prompt was detected in this data chunk). Enter accepts (default is Yes).
    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);
      if (!this.pty) return;

      // Bypass Permissions prompt — "Bypass" is always a continuous substring in raw PTY data
      if (!bypassAccepted && data.includes('Bypass')) {
        bypassAccepted = true;   // set synchronously — blocks trust handler below
        this.pty.write('\x1b[B'); // down arrow → move to "Yes, I accept"
        setTimeout(() => { if (this.pty) this.pty.write('\r'); }, 300);
        return;
      }

      // Trust folder prompt — only fires if bypass wasn't detected in this chunk
      if (!trustAccepted && data.includes('trust')) {
        trustAccepted = true;
        this.pty.write('\r');
      }
    });

    // Set up exit handler
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });

    // Fallback probes: re-scan recent buffer in case the onData handler missed
    // a prompt that arrived before registration.
    const acceptPromptFallback = () => {
      if (!this.pty) return;
      const recent = this.outputBuffer.getRecent();
      if (!bypassAccepted && recent.includes('Bypass')) {
        bypassAccepted = true;
        this.pty.write('\x1b[B');
        setTimeout(() => { if (this.pty) this.pty.write('\r'); }, 300);
      } else if (!trustAccepted && recent.includes('trust')) {
        trustAccepted = true;
        this.pty.write('\r');
      }
    };
    setTimeout(acceptPromptFallback, 2000);
    setTimeout(acceptPromptFallback, 5000);
  }

  /**
   * Returns the binary name for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   */
  protected getBinaryName(): string {
    if (platform() !== 'win32') return 'claude';
    // The Claude Code Windows installer historically shipped a `claude.cmd`
    // shim alongside `claude.exe`. Newer installers (e.g. when claude lives
    // under `~/.local/bin`) ship only `claude.exe` and have no `.cmd` shim.
    // Hardcoding `claude.cmd` causes node-pty/ConPTY to fail with an empty
    // "File not found" error before the agent ever boots.
    //
    // Probe PATH for whichever extension is present and prefer `.exe` —
    // it spawns more cleanly under ConPTY than a `.cmd` wrapper, and matches
    // what `where.exe claude` returns on current installs.
    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `claude${ext}`))) {
          return `claude${ext}`;
        }
      }
    }
    // Neither found on PATH — fall back to the legacy default so the error
    // message from node-pty surfaces a recognizable filename for debugging.
    return 'claude.cmd';
  }

  /**
   * Build the claude CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    // Skip Claude Code's permission system by default (back-compat: agents have
    // historically run unattended). Set `dangerously_skip_permissions: false` in
    // the agent config to KEEP the gate on — then Claude Code's PermissionRequest
    // flow (and the hook-permission-telegram approval) actually engages. Without
    // this flag the CLI override would suppress any settings.json permission mode.
    // Only the literal boolean `false` disables the skip; warn on a non-boolean so
    // a typo (e.g. the string "false") can't silently leave an agent ungated when
    // the operator intended to engage the gate.
    //
    // When skipping, use `--permission-mode bypassPermissions` rather than
    // `--dangerously-skip-permissions`: it is equivalent but does NOT show the
    // interactive confirmation prompt added in CC 2.1+, which would otherwise
    // hang a headless daemon agent.
    const skipPermissions = this.config.dangerously_skip_permissions;
    if (skipPermissions !== undefined && typeof skipPermissions !== 'boolean') {
      console.warn(
        `[agent-pty] ${this.env.agentName}: dangerously_skip_permissions must be true or false ` +
        `(got ${JSON.stringify(skipPermissions)}); defaulting to skip-on.`,
      );
    }
    if (skipPermissions !== false) {
      args.push('--permission-mode', 'bypassPermissions');
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Local override pattern (feat #20): concatenate {agentDir}/local/*.md files
    // and append as system prompt. The local/ dir is gitignored so users can customize
    // agent behavior without merge conflicts on framework updates.
    const agentDir = this.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    // Pass prompt as a plain string — no shell escaping needed when using node-pty directly
    args.push(prompt);

    return args;
  }

  /**
   * Write data to the PTY.
   */
  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    this.pty.write(data);
  }

  /**
   * Kill the PTY process.
   */
  kill(): void {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      pty.kill();
    }
  }

  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  /**
   * Get the PTY PID.
   */
  getPid(): number | null {
    return this.pty?.pid || null;
  }

  /**
   * Register an exit handler.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy essential env vars
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
      'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      // Windows path-expansion essentials. Stripping these causes phantom
      // %SystemDrive% directories from inherited Search Indexer processes
      // and Unity batchmode UPM IPC crashes (path.join(undefined,...)).
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Windows: ensure UTF-8 locale so emoji and Unicode pass through the PTY
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }

    return env;
  }
}
