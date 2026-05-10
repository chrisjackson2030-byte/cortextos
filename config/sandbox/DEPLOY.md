# cortextOS Sandbox-Exec Deployment Guide

**Status:** DRAFT — profiles tested on macOS Sequoia 15.7.3 M4. Deployment to any agent requires explicit B approval.
**Gate:** Deploy to Atlas first (24h observe window), then fleet rollout.

---

## Profile Summary

| Profile | Agent types | Key restriction |
|---|---|---|
| `cortextos-specialist.sb` | atlas, forge, analyst | Reads: allowed everywhere, DENY per-sibling; Writes: own dir + CTX_ROOT only |
| `cortextos-orchestrator.sb` | jarvis | Reads: everywhere (fleet management); Writes: own dir + CTX_ROOT only |
| `cortextos-worker.sb` | spawn-worker sessions | Reads: everywhere, DENY all persistent agent dirs; Writes: TASK_DIR + CTX_ROOT only; HTTPS-only network |

All profiles: deny-default, HTTPS + DNS outbound, daemon socket for self-restart.

---

## Design Note: Broad Read + Targeted Denies

The profiles use `(allow file-read* (subpath "/"))` (read everywhere) then `(deny file-read* ...)` for sibling agent dirs. **Do NOT switch to a restrictive read-allowlist approach** — attempting to enumerate only necessary read paths causes SIGABRT on Sequoia 15.x because macOS processes need reads across many undocumented system paths at startup. The broad-read + targeted-deny pattern is verified working.

---

## Step 1: Add `sandbox_profile` to AgentConfig type

File: `src/types/index.ts`

```typescript
export interface AgentConfig {
  // ... existing fields ...

  /**
   * Path to sandbox-exec Seatbelt profile (.sb file).
   * When set, agent is launched via `sandbox-exec -f <profile> [params]`.
   * macOS only. Absent = no sandboxing (existing behaviour preserved).
   */
  sandbox_profile?: string;
}
```

---

## Step 2: Modify agent-pty.ts spawn

File: `src/pty/agent-pty.ts`

Replace the spawn block (~line 147):

```typescript
const claudeArgs = this.buildClaudeArgs(mode, prompt);
let claudeCmd = this.getBinaryName();

// sandbox-exec wrapping — macOS only, opt-in via config.json sandbox_profile
if (this.config.sandbox_profile && platform() === 'darwin') {
  const agentDir = join(
    this.env.projectRoot ?? '',
    'orgs', this.env.org ?? '', 'agents', this.env.agentName ?? ''
  );
  // Claude project dir path: ~/.claude/projects/{working-dir-path-with-slashes-as-dashes}
  const claudeProjHash = agentDir.replace(/\//g, '-').replace(/^-/, '');
  const claudeProjDir = join(
    process.env.HOME ?? '',
    '.claude', 'projects', claudeProjHash
  );
  const orgDir = join(this.env.projectRoot ?? '', 'orgs', this.env.org ?? '');
  const ctxRoot = this.env.ctxRoot ?? '';
  const daemonSock = join(ctxRoot, 'daemon.sock');

  // Build sibling deny list: all other agents in the same org
  // Unused slots use a non-existent sentinel path (deny of a non-existent path is a no-op)
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
  } catch { /* if agents dir unreadable, proceed without sibling denies */ }
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
```

Imports to add: `readdirSync` (already imported for other uses; verify).

---

## Step 3: Per-agent config.json entries

### Atlas (specialist)
```json
{
  "agent_name": "atlas",
  "sandbox_profile": "/Users/chrisjackson/cortextos/config/sandbox/cortextos-specialist.sb"
}
```

### Forge (specialist)
```json
{
  "agent_name": "forge",
  "sandbox_profile": "/Users/chrisjackson/cortextos/config/sandbox/cortextos-specialist.sb"
}
```

### Analyst (specialist)
```json
{
  "agent_name": "analyst",
  "sandbox_profile": "/Users/chrisjackson/cortextos/config/sandbox/cortextos-specialist.sb"
}
```

### Jarvis (orchestrator)
```json
{
  "agent_name": "jarvis",
  "sandbox_profile": "/Users/chrisjackson/cortextos/config/sandbox/cortextos-orchestrator.sb"
}
```

Worker profiles are applied programmatically in the spawn-worker command — no config.json entry needed.

---

## Step 4: Test results (verified on Sequoia 15.7.3 M4)

All 6 tests passed against Atlas agent directory structure:

| Test | Result |
|---|---|
| Profile loads, atlas reads work | PASS |
| Cross-agent read blocked (forge) | PASS — `Operation not permitted` |
| Cross-agent read blocked (jarvis) | PASS — `Operation not permitted` |
| Cross-agent write blocked (forge) | PASS — `Operation not permitted` |
| Own dir write allowed | PASS |
| CTX_ROOT write allowed (bus ops) | PASS |

Manual test command (reproduce on any machine):
```bash
PROJ=/Users/chrisjackson/cortextos
CTX_ROOT=/Users/chrisjackson/.cortextos/default

sandbox-exec -f $PROJ/config/sandbox/cortextos-specialist.sb \
  -D AGENT_DIR=$PROJ/orgs/main/agents/atlas \
  -D CTX_ROOT=$CTX_ROOT \
  -D HOME_DIR=/Users/chrisjackson \
  -D CLAUDE_PROJ_DIR=/Users/chrisjackson/.claude/projects/-Users-chrisjackson-cortextos-orgs-main-agents-atlas \
  -D DAEMON_SOCK=$CTX_ROOT/daemon.sock \
  -D DENY_AGENT_1=$PROJ/orgs/main/agents/forge \
  -D DENY_AGENT_2=$PROJ/orgs/main/agents/jarvis \
  -D DENY_AGENT_3=$PROJ/orgs/main/agents/analyst \
  -D DENY_AGENT_4=/nonexistent-sandbox-placeholder \
  /bin/bash -c 'echo "atlas read: $(cat '"$PROJ/orgs/main/agents/atlas/MEMORY.md"' | head -1)"; cat '"$PROJ/orgs/main/agents/forge/MEMORY.md"' 2>&1 | grep -q "not permitted" && echo "forge: BLOCKED" || echo "forge: FAIL"'
```

---

## Step 5: Deploy to Atlas (24h observe window)

Requires explicit B approval before proceeding.

1. Add `sandbox_profile` to `orgs/main/agents/atlas/config.json`
2. `npm run build` — compile TypeScript changes
3. Restart atlas: `cortextos bus self-restart --reason "sandbox-exec activation"`
4. Monitor 24h:
   - Heartbeat continuity (no crashes from EPERM on unexpected paths)
   - Bus ops working: `cortextos bus check-inbox`, `cortextos bus log-event`
   - Telegram delivery working
   - Research tasks completing (file reads in research/ dir)
5. If clean: extend to forge → analyst → jarvis (in that order)

---

## Known Limitations

**No hostname-based network filtering:** Port 443 allows ALL HTTPS endpoints. Cannot restrict to api.anthropic.com specifically via sandbox-exec — would require a network proxy layer (mitmproxy, pf rules) outside this profile's scope.

**Sentinel for unused deny slots:** When fewer than 4 sibling agents exist, use `/nonexistent-sandbox-placeholder` for extra DENY_AGENT_* slots. Do NOT use `/dev/null` — it will deny process output redirection and crash the session.

**More than 4 siblings:** If the fleet grows beyond 4 agents, the profile needs additional DENY_AGENT_* params. Update both the profile and the agent-pty.ts param-builder accordingly.

**Deprecation notice:** `sandbox-exec` marked deprecated since 2017; binary last modified November 2025 (Sequoia 15.x). No production replacement exists for unsigned CLI tools. Risk: low for 12-24 month horizon.

---

## Rollback

Remove `sandbox_profile` from `config.json` and restart the agent. No other changes. The agent returns to unsandboxed operation immediately on next session start.
