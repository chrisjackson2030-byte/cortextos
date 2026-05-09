import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { indexSessions, searchSessions, listSessions, getSessionContext } from '../../../src/bus/indexer.js';
import type { IndexStats } from '../../../src/bus/indexer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'synthetic-session.jsonl');

const SESSION_ID   = 'test-session-uuid-0001';
const AGENT_NAME   = 'forge';
const PROJECT_SLUG = `-agents-${AGENT_NAME}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempProjectsDir(): { projectsDir: string; projectDir: string } {
  const projectsDir = mkdtempSync(join(tmpdir(), 'indexer-int-test-'));
  const projectDir  = join(projectsDir, PROJECT_SLUG);
  mkdirSync(projectDir, { recursive: true });
  return { projectsDir, projectDir };
}

function cleanupInstance(instanceId: string): void {
  const dbDir = join(homedir(), '.cortextos', instanceId);
  if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Main fixture — synthetic-session.jsonl
// ---------------------------------------------------------------------------

describe('JSONL Indexer — integration (main fixture)', () => {
  let projectsDir: string;
  let instanceId: string;
  let stats: IndexStats;

  beforeAll(async () => {
    const { projectsDir: pd, projectDir } = makeTempProjectsDir();
    projectsDir = pd;
    instanceId  = `test-main-${Date.now()}`;

    copyFileSync(FIXTURE_PATH, join(projectDir, `${SESSION_ID}.jsonl`));

    stats = await indexSessions(instanceId, { projectsDirOverride: projectsDir });
  });

  afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
    cleanupInstance(instanceId);
  });

  // -------------------------------------------------------------------------
  // indexSessions stats
  // -------------------------------------------------------------------------

  describe('indexSessions', () => {
    it('reports 1 session, no errors, no skips', () => {
      expect(stats.sessions).toBe(1);
      expect(stats.skipped).toBe(0);
      expect(stats.errors).toHaveLength(0);
    });

    it('indexes 8 turns (4 user + 4 assistant; skips system/attachment/perm/last-prompt)', () => {
      expect(stats.turns).toBe(8);
    });

    it('indexes 2 tool calls (Bash calls from two assistant turns)', () => {
      expect(stats.toolCalls).toBe(2);
    });

    it('indexes 2 tool results (one per tool use)', () => {
      expect(stats.toolResults).toBe(2);
    });

    it('indexes 1 thinking block (from asst-turn-001)', () => {
      expect(stats.thinkingBlocks).toBe(1);
    });

    it('reports no scrub matches for the clean fixture', () => {
      expect(stats.scrubMatches).toBe(0);
    });

    it('re-run skips the unchanged session', async () => {
      const stats2 = await indexSessions(instanceId, { projectsDirOverride: projectsDir });
      expect(stats2.skipped).toBe(1);
      expect(stats2.sessions).toBe(0);
      expect(stats2.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns exactly one session', () => {
      const rows = listSessions(instanceId);
      expect(rows).toHaveLength(1);
    });

    it('has correct session_id and agent_name', () => {
      const [s] = listSessions(instanceId);
      expect(s.session_id).toBe(SESSION_ID);
      expect(s.agent_name).toBe(AGENT_NAME);
    });

    it('has correct git_branch from the user line', () => {
      const [s] = listSessions(instanceId);
      expect(s.git_branch).toBe('main');
    });

    it('accumulates token usage correctly across all assistant turns', () => {
      // asst-turn-001: in=150 out=45  cr=1200 cc=0
      // asst-turn-002: in=200 out=30  cr=1500 cc=0
      // asst-turn-003: in=250 out=40  cr=1600 cc=0
      // asst-turn-004: in=300 out=25  cr=1800 cc=0
      const [s] = listSessions(instanceId);
      expect(s.total_input_tokens).toBe(900);
      expect(s.total_output_tokens).toBe(140);
      expect(s.total_cache_read).toBe(6100);
      expect(s.total_cache_created).toBe(0);
    });

    it('defaults retention_tier to "full"', () => {
      const [s] = listSessions(instanceId);
      expect(s.retention_tier).toBe('full');
    });

    it('filters by agent_name', () => {
      expect(listSessions(instanceId, { agent: AGENT_NAME })).toHaveLength(1);
      expect(listSessions(instanceId, { agent: 'nonexistent' })).toHaveLength(0);
    });

    it('filters by date range (after)', () => {
      expect(listSessions(instanceId, { after: '2026-05-01T00:00:00Z' })).toHaveLength(1);
      expect(listSessions(instanceId, { after: '2030-01-01T00:00:00Z' })).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // searchSessions — turns_fts (text content)
  // -------------------------------------------------------------------------

  describe('searchSessions — turns_fts', () => {
    it('finds turns mentioning "build"', () => {
      const results = searchSessions(instanceId, 'build');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.session_id === SESSION_ID)).toBe(true);
    });

    it('finds turns mentioning "staging"', () => {
      const results = searchSessions(instanceId, 'staging');
      expect(results.length).toBeGreaterThan(0);
    });

    it('finds turns mentioning "indexer"', () => {
      const results = searchSessions(instanceId, 'indexer');
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns results with the expected shape', () => {
      const [r] = searchSessions(instanceId, 'build');
      expect(r).toMatchObject({
        session_id: SESSION_ID,
        agent_name: AGENT_NAME,
        role: expect.stringMatching(/^(user|assistant)$/),
        timestamp: expect.any(String),
        score: expect.any(Number),
        turn_index: expect.any(Number),
      });
      expect(Array.isArray(r.context_before)).toBe(true);
      expect(Array.isArray(r.context_after)).toBe(true);
    });

    it('respects topK limit', () => {
      const results = searchSessions(instanceId, 'build', { topK: 1 });
      expect(results).toHaveLength(1);
    });

    it('filters by role=user', () => {
      const results = searchSessions(instanceId, 'build', { role: 'user' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.role === 'user')).toBe(true);
    });

    it('filters by role=assistant', () => {
      const results = searchSessions(instanceId, 'build', { role: 'assistant' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.role === 'assistant')).toBe(true);
    });

    it('filters by agent', () => {
      expect(searchSessions(instanceId, 'build', { agent: AGENT_NAME }).length).toBeGreaterThan(0);
      expect(searchSessions(instanceId, 'build', { agent: 'nonexistent' })).toHaveLength(0);
    });

    it('filters by after timestamp', () => {
      const results = searchSessions(instanceId, 'build', { after: '2026-05-08T00:59:00Z' });
      expect(results.length).toBeGreaterThan(0);
      const none   = searchSessions(instanceId, 'build', { after: '2030-01-01T00:00:00Z' });
      expect(none).toHaveLength(0);
    });

    it('includes context window turns around each result', () => {
      const results = searchSessions(instanceId, 'staging', { contextWindow: 2 });
      expect(results.length).toBeGreaterThan(0);
      const [r] = results;
      // Context arrays may be non-empty for mid-session turns
      expect(r.context_before.length + r.context_after.length).toBeGreaterThan(0);
    });

    it('disables context window when contextWindow=0', () => {
      const results = searchSessions(instanceId, 'build', { contextWindow: 0 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.context_before.length === 0 && r.context_after.length === 0)).toBe(true);
    });

    it('finds assistant turns via content_text (thinking is now in thinking_fts, not turns_fts)', () => {
      // asst-turn-001 content_text: "Let me check the build status for you."
      // asst-turn-002 content_text: "The build is successful..."
      const results = searchSessions(instanceId, 'build');
      expect(results.some(r => r.role === 'assistant')).toBe(true);
    });

    it('finds thinking block content via thinking_fts (thinkingOnly: true)', () => {
      // asst-turn-001 thinking: "The user wants a build status update..."
      const results = searchSessions(instanceId, 'build', { thinkingOnly: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].role).toBe('assistant');
      expect(results[0].content_text).toContain('build status update');
    });

    it('returns empty for a term not in the fixture', () => {
      expect(searchSessions(instanceId, 'xyzzy_nonexistent_term_42')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // searchSessions — tools_fts (tool call inputs)
  // -------------------------------------------------------------------------

  describe('searchSessions — tools_fts', () => {
    it('finds tool calls matching "npm" (Bash: npm run build)', () => {
      const results = searchSessions(instanceId, 'npm', { toolsOnly: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tool_name).toBe('Bash');
    });

    it('finds tool calls matching "deploy"', () => {
      const results = searchSessions(instanceId, 'deploy', { toolsOnly: true });
      expect(results.length).toBeGreaterThan(0);
    });

    it('filters tools results by agent', () => {
      expect(searchSessions(instanceId, 'npm', { toolsOnly: true, agent: AGENT_NAME }).length).toBeGreaterThan(0);
      expect(searchSessions(instanceId, 'npm', { toolsOnly: true, agent: 'other' })).toHaveLength(0);
    });

    it('returns tool_name in results', () => {
      const results = searchSessions(instanceId, 'npm', { toolsOnly: true });
      expect(results.every(r => r.tool_name === 'Bash')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getSessionContext
  // -------------------------------------------------------------------------

  describe('getSessionContext — window mode', () => {
    it('returns window mode when no flags set', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID);
      expect(ctx.mode).toBe('window');
      expect(ctx.turns).toBeDefined();
    });

    it('returns turns around the pivot (default window=5, pivot=0)', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { turn: 0, window: 5 });
      expect(ctx.turns).toBeDefined();
      expect(ctx.turns!.length).toBeGreaterThan(0);
      expect(ctx.turns!.every(t => t.turn_index <= 5)).toBe(true);
    });

    it('returns turns around a mid-session pivot', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { turn: 4, window: 2 });
      expect(ctx.turns).toBeDefined();
      const indices = ctx.turns!.map(t => t.turn_index);
      expect(Math.min(...indices)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...indices)).toBeLessThanOrEqual(6);
    });

    it('turns have expected shape', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { turn: 0, window: 3 });
      const [t] = ctx.turns!;
      expect(t).toMatchObject({
        turn_id: expect.any(Number),
        session_id: SESSION_ID,
        turn_index: expect.any(Number),
        role: expect.stringMatching(/^(user|assistant)$/),
        timestamp: expect.any(String),
      });
    });
  });

  describe('getSessionContext — tool-calls mode', () => {
    it('returns tool-calls mode', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { toolCalls: true });
      expect(ctx.mode).toBe('tool-calls');
      expect(ctx.toolCalls).toBeDefined();
    });

    it('returns exactly 2 tool calls (fixture has 2 Bash calls)', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { toolCalls: true });
      expect(ctx.toolCalls).toHaveLength(2);
    });

    it('tool call entries have expected shape', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { toolCalls: true });
      const [tc] = ctx.toolCalls!;
      expect(tc).toMatchObject({
        turn_index: expect.any(Number),
        timestamp: expect.any(String),
        tool_name: 'Bash',
        tool_use_id: expect.any(String),
        input_json: expect.any(String),
      });
    });
  });

  describe('getSessionContext — summary mode', () => {
    it('returns summary mode', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { summary: true });
      expect(ctx.mode).toBe('summary');
      expect(ctx.summary).toBeDefined();
    });

    it('summary has correct session metadata', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { summary: true });
      const s = ctx.summary!;
      expect(s.session_id).toBe(SESSION_ID);
      expect(s.agent_name).toBe(AGENT_NAME);
      expect(s.total_turns).toBe(8);
    });

    it('summary includes first and last turns', () => {
      const ctx = getSessionContext(instanceId, SESSION_ID, { summary: true });
      const s = ctx.summary!;
      expect(s.first_turn).not.toBeNull();
      expect(s.last_turn).not.toBeNull();
      expect(s.first_turn!.turn_index).toBeLessThan(s.last_turn!.turn_index);
    });

    it('returns undefined summary for unknown session', () => {
      const ctx = getSessionContext(instanceId, 'nonexistent-session-id', { summary: true });
      expect(ctx.summary).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Secrets scrubbing — end-to-end with synthetic secret
// ---------------------------------------------------------------------------

describe('JSONL Indexer — secrets scrubbing integration', () => {
  const SECRET_SESSION = 'test-session-scrub-0001';
  let projectsDir: string;
  let instanceId: string;

  beforeAll(async () => {
    const { projectsDir: pd, projectDir } = makeTempProjectsDir();
    projectsDir = pd;
    instanceId  = `test-scrub-${Date.now()}`;

    // One assistant turn with a synthetic AWS key embedded in content
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'asst-scrub-001',
      parentUuid: null,
      timestamp: '2026-05-08T02:00:00.000Z',
      sessionId: SECRET_SESSION,
      gitBranch: 'main',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [{
          type: 'text',
          text: 'Use this credential to authenticate: AKIAIOSFODNN7EXAMPLE12 please store safely.',
        }],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    writeFileSync(join(projectDir, `${SECRET_SESSION}.jsonl`), line + '\n');

    await indexSessions(instanceId, { projectsDirOverride: projectsDir });
  });

  afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
    cleanupInstance(instanceId);
  });

  it('indexes the session without errors', async () => {
    const stats = await indexSessions(instanceId, {
      projectsDirOverride: projectsDir,
      force: true,
    });
    expect(stats.errors).toHaveLength(0);
    expect(stats.scrubMatches).toBeGreaterThan(0);
  });

  it('stores [REDACTED_AWS_KEY] instead of the raw key', () => {
    // "please" and "store" appear adjacent to the secret in the original text
    // and survive scrubbing — use them to locate the turn
    const results = searchSessions(instanceId, 'please');
    expect(results.length).toBeGreaterThan(0);
    const [r] = results;
    expect(r.content_text).toContain('[REDACTED_AWS_KEY]');
    expect(r.content_text).not.toContain('AKIAIOSFODNN7EXAMPLE12');
  });
});

// ---------------------------------------------------------------------------
// Incremental indexing — append-only growth
// ---------------------------------------------------------------------------

describe('JSONL Indexer — incremental indexing', () => {
  const BASE_SESSION = 'test-session-incr-0001';
  let projectsDir: string;
  let projectDir: string;
  let instanceId: string;
  let sessionFile: string;

  beforeAll(async () => {
    ({ projectsDir, projectDir } = makeTempProjectsDir());
    instanceId  = `test-incr-${Date.now()}`;
    sessionFile = join(projectDir, `${BASE_SESSION}.jsonl`);

    // Initial: one user turn
    const line1 = JSON.stringify({
      type: 'user',
      uuid: 'u-incr-001',
      parentUuid: null,
      timestamp: '2026-05-08T03:00:00.000Z',
      sessionId: BASE_SESSION,
      gitBranch: 'main',
      cwd: '/tmp',
      version: '2.1.119',
      message: { role: 'user', content: 'First message.' },
    });
    writeFileSync(sessionFile, line1 + '\n');

    await indexSessions(instanceId, { projectsDirOverride: projectsDir });
  });

  afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
    cleanupInstance(instanceId);
  });

  it('indexes 1 turn on initial index', () => {
    const rows = listSessions(instanceId);
    expect(rows).toHaveLength(1);
    const results = searchSessions(instanceId, 'first');
    expect(results.length).toBeGreaterThan(0);
  });

  it('indexes only the new turn on incremental run after append', async () => {
    // Append a second turn to the same file
    const line2 = JSON.stringify({
      type: 'user',
      uuid: 'u-incr-002',
      parentUuid: 'u-incr-001',
      timestamp: '2026-05-08T03:01:00.000Z',
      sessionId: BASE_SESSION,
      gitBranch: 'main',
      cwd: '/tmp',
      version: '2.1.119',
      message: { role: 'user', content: 'Second message incremental.' },
    });
    // Append to file
    const { appendFileSync } = await import('fs');
    appendFileSync(sessionFile, line2 + '\n');

    const stats = await indexSessions(instanceId, { projectsDirOverride: projectsDir });
    expect(stats.sessions).toBe(1);
    expect(stats.turns).toBe(1); // only the new turn
    expect(stats.errors).toHaveLength(0);

    // Both turns should now be findable
    const first  = searchSessions(instanceId, 'first');
    const second = searchSessions(instanceId, 'incremental');
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });
});
