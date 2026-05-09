import Database from 'better-sqlite3';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
  ensureIndexerDir,
  indexerDbPath,
  applySchema,
} from './indexer-schema.js';
import { parseLine, extractSessionMetadata } from './indexer-parser.js';
import { scrubSecrets, scrubToolInput } from './indexer-scrubber.js';
import {
  discoverSessions,
  discoverSessionsForAgent,
  buildIndexPlan,
  type DiscoveredSession,
  type StoredSessionInfo,
  type SessionIndexPlan,
} from './indexer-discovery.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexOptions {
  /** Filter to a specific agent's sessions. */
  agent?: string;
  /** Filter to a specific session UUID. */
  session?: string;
  /** Force full reindex even for unchanged files. */
  force?: boolean;
  /** Override the Claude projects directory (for testing). */
  projectsDirOverride?: string;
}

export interface IndexStats {
  sessions: number;
  turns: number;
  toolCalls: number;
  toolResults: number;
  thinkingBlocks: number;
  scrubMatches: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

export interface SearchOptions {
  agent?: string;
  /** ISO 8601 — only turns at or after this timestamp. */
  after?: string;
  /** ISO 8601 — only turns at or before this timestamp. */
  before?: string;
  role?: 'user' | 'assistant';
  /** Search tool call inputs only (tools_fts). */
  toolsOnly?: boolean;
  /** Search thinking block content only (thinking_fts). */
  thinkingOnly?: boolean;
  topK?: number;
  /** Number of surrounding turns to include. Default 2. */
  contextWindow?: number;
}

export interface SearchResult {
  turn_id: number;
  session_id: string;
  agent_name: string;
  role: string;
  timestamp: string;
  content_text: string | null;
  score: number;
  turn_index: number;
  model: string | null;
  tool_name: string | null;
  context_before: ContextTurn[];
  context_after: ContextTurn[];
}

export interface ContextTurn {
  turn_id: number;
  session_id: string;
  role: string;
  timestamp: string;
  content_text: string | null;
  turn_index: number;
}

export interface SessionListOptions {
  agent?: string;
  after?: string;
  before?: string;
}

export interface SessionRow {
  session_id: string;
  agent_name: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  git_branch: string | null;
  total_lines: number;
  indexed_lines: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_created: number;
  retention_tier: string;
}

export interface SessionContextOptions {
  /** Pivot turn index — enables window mode. */
  turn?: number;
  /** Turns before/after pivot to include (default 5). */
  window?: number;
  /** Return all tool calls in the session instead of turns. */
  toolCalls?: boolean;
  /** Return session summary (first/last turns + token totals). */
  summary?: boolean;
}

export interface SessionContextTurn {
  turn_id: number;
  session_id: string;
  turn_index: number;
  role: string;
  timestamp: string;
  content_text: string | null;
  model: string | null;
}

export interface SessionContextToolCall {
  turn_index: number;
  timestamp: string;
  tool_name: string;
  tool_use_id: string;
  input_json: string;
}

export interface SessionContextSummary {
  session_id: string;
  agent_name: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  first_turn: SessionContextTurn | null;
  last_turn: SessionContextTurn | null;
}

export interface SessionContext {
  session_id: string;
  mode: 'window' | 'tool-calls' | 'summary';
  turns?: SessionContextTurn[];
  toolCalls?: SessionContextToolCall[];
  summary?: SessionContextSummary;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function openDatabase(instanceId: string): InstanceType<typeof Database> {
  ensureIndexerDir(instanceId);
  const dbPath = indexerDbPath(instanceId);
  const db = new Database(dbPath);
  applySchema(db);
  return db;
}

function getStoredSession(
  db: InstanceType<typeof Database>,
  sessionId: string,
): StoredSessionInfo | null {
  const row = db.prepare(
    'SELECT indexed_lines AS indexedLines, file_size AS fileSize, file_mtime AS fileMtime FROM sessions WHERE session_id = ?',
  ).get(sessionId) as StoredSessionInfo | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Core indexing — single session file
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

interface SessionFileStats {
  turns: number;
  toolCalls: number;
  toolResults: number;
  thinkingBlocks: number;
  scrubMatches: number;
}

async function indexSessionFile(
  db: InstanceType<typeof Database>,
  plan: SessionIndexPlan,
): Promise<SessionFileStats> {
  const { session, action, resumeFromLine, storedFileSize } = plan;
  const stats: SessionFileStats = { turns: 0, toolCalls: 0, toolResults: 0, thinkingBlocks: 0, scrubMatches: 0 };

  // Ensure session row exists; for reindex, clear old turn data first.
  if (action === 'reindex') {
    db.prepare('DELETE FROM thinking_blocks WHERE session_id = ?').run(session.sessionId);
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(session.sessionId);
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(session.sessionId);
    db.prepare('DELETE FROM tool_results WHERE session_id = ?').run(session.sessionId);
    db.prepare(
      'UPDATE sessions SET indexed_lines = 0, file_size = 0, total_input_tokens = 0, total_output_tokens = 0, total_cache_read = 0, total_cache_created = 0 WHERE session_id = ?',
    ).run(session.sessionId);
  }

  db.prepare(
    'INSERT OR IGNORE INTO sessions (session_id, agent_name, project_slug, started_at) VALUES (?, ?, ?, ?)',
  ).run(session.sessionId, session.agentName, session.projectSlug, new Date().toISOString());

  // Prepared statements
  const stmtInsertTurn = db.prepare(`
    INSERT INTO turns
      (session_id, uuid, parent_uuid, turn_index, role, timestamp,
       content_text, has_tool_use, stop_reason,
       input_tokens, output_tokens, model, line_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtInsertThinkingBlock = db.prepare(`
    INSERT INTO thinking_blocks (turn_id, session_id, sequence_in_turn, content, indexed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const stmtInsertToolCall = db.prepare(`
    INSERT INTO tool_calls (turn_id, session_id, tool_use_id, tool_name, input_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const stmtInsertToolResult = db.prepare(`
    INSERT INTO tool_results (tool_use_id, session_id, content_text, is_error, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const stmtInsertScrubLog = db.prepare(`
    INSERT INTO scrub_log (session_id, turn_id, pattern, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const stmtUpdateSession = db.prepare(`
    UPDATE sessions
    SET indexed_lines          = ?,
        file_size              = ?,
        file_mtime             = ?,
        total_input_tokens     = total_input_tokens     + ?,
        total_output_tokens    = total_output_tokens    + ?,
        total_cache_read       = total_cache_read       + ?,
        total_cache_created    = total_cache_created    + ?
    WHERE session_id = ?
  `);

  const stmtUpdateSessionMeta = db.prepare(`
    UPDATE sessions
    SET model      = COALESCE(model,      ?),
        git_branch = COALESCE(git_branch, ?),
        cwd        = COALESCE(cwd,        ?),
        started_at = COALESCE(started_at, ?)
    WHERE session_id = ?
  `);

  type BatchItem = { parsed: NonNullable<ReturnType<typeof parseLine>>; byteOff: number };

  const flushBatch = db.transaction((items: BatchItem[]) => {
    const now = new Date().toISOString();
    for (const { parsed, byteOff } of items) {
      const scrubContent = parsed.contentText != null ? scrubSecrets(parsed.contentText) : null;

      const result = stmtInsertTurn.run(
        session.sessionId,
        parsed.uuid,
        parsed.parentUuid,
        parsed.turnIndex,
        parsed.role,
        parsed.timestamp,
        scrubContent?.text ?? null,
        parsed.hasToolUse ? 1 : 0,
        parsed.stopReason,
        parsed.tokenUsage?.input_tokens ?? null,
        parsed.tokenUsage?.output_tokens ?? null,
        parsed.model,
        byteOff,
      );
      const turnId = Number(result.lastInsertRowid);
      stats.turns++;

      for (const m of scrubContent?.matches ?? []) {
        stmtInsertScrubLog.run(session.sessionId, turnId, m.patternName, now);
        stats.scrubMatches++;
      }

      for (const tb of parsed.thinkingBlocks) {
        const scrubThinking = scrubSecrets(tb.content);
        stmtInsertThinkingBlock.run(turnId, session.sessionId, tb.sequence_in_turn, scrubThinking.text, now);
        for (const m of scrubThinking.matches) {
          stmtInsertScrubLog.run(session.sessionId, turnId, `thinking:${m.patternName}`, now);
          stats.scrubMatches++;
        }
        stats.thinkingBlocks++;
      }

      for (const tc of parsed.toolCalls) {
        const scrubInput = scrubToolInput(tc.input_json);
        stmtInsertToolCall.run(turnId, session.sessionId, tc.tool_use_id, tc.tool_name, scrubInput.text, parsed.timestamp);
        for (const m of scrubInput.matches) {
          stmtInsertScrubLog.run(session.sessionId, turnId, `tool_input:${m.patternName}`, now);
          stats.scrubMatches++;
        }
        stats.toolCalls++;
      }

      for (const tr of parsed.toolResults) {
        const scrubResult = scrubSecrets(tr.content_text);
        stmtInsertToolResult.run(tr.tool_use_id, session.sessionId, scrubResult.text, tr.is_error ? 1 : 0, parsed.timestamp);
        for (const m of scrubResult.matches) {
          stmtInsertScrubLog.run(session.sessionId, turnId, `tool_result:${m.patternName}`, now);
          stats.scrubMatches++;
        }
        stats.toolResults++;
      }
    }
  });

  // Streaming read — start from byte offset for incremental
  const readStart = action === 'incremental' ? storedFileSize : 0;
  const stream = createReadStream(session.filePath, { start: readStart });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let turnIndex = resumeFromLine;
  let byteOffset = readStart;
  let metaExtracted = action !== 'full'; // full index needs metadata from first lines
  let tokenInputAcc = 0;
  let tokenOutputAcc = 0;
  let tokenCacheReadAcc = 0;
  let tokenCacheCreatedAcc = 0;
  const batch: BatchItem[] = [];

  return new Promise<SessionFileStats>((resolve, reject) => {
    rl.on('line', (rawLine) => {
      const lineByteLen = Buffer.byteLength(rawLine, 'utf8') + 1; // +1 for newline

      if (!metaExtracted) {
        const meta = extractSessionMetadata(rawLine);
        if (meta) {
          stmtUpdateSessionMeta.run(meta.model, meta.gitBranch, meta.cwd, meta.startedAt, session.sessionId);
          metaExtracted = true;
        }
      }

      const parsed = parseLine(rawLine, turnIndex, byteOffset);
      if (parsed) {
        batch.push({ parsed, byteOff: byteOffset });
        if (parsed.tokenUsage) {
          tokenInputAcc += parsed.tokenUsage.input_tokens;
          tokenOutputAcc += parsed.tokenUsage.output_tokens;
          tokenCacheReadAcc += parsed.tokenUsage.cache_read_input_tokens;
          tokenCacheCreatedAcc += parsed.tokenUsage.cache_creation_input_tokens;
        }
        if (batch.length >= BATCH_SIZE) {
          flushBatch(batch.splice(0));
        }
      }

      byteOffset += lineByteLen;
      turnIndex++;
    });

    rl.on('close', () => {
      if (batch.length > 0) {
        flushBatch(batch.splice(0));
      }
      stmtUpdateSession.run(
        turnIndex,
        session.fileSize,
        session.fileMtime,
        tokenInputAcc,
        tokenOutputAcc,
        tokenCacheReadAcc,
        tokenCacheCreatedAcc,
        session.sessionId,
      );
      resolve(stats);
    });

    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Public API — indexing
// ---------------------------------------------------------------------------

export async function indexSessions(
  instanceId: string,
  options: IndexOptions = {},
): Promise<IndexStats> {
  const startTime = Date.now();
  const db = openDatabase(instanceId);
  const allStats: IndexStats = {
    sessions: 0,
    turns: 0,
    toolCalls: 0,
    toolResults: 0,
    thinkingBlocks: 0,
    scrubMatches: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    const discovered = options.agent
      ? discoverSessionsForAgent(options.agent, options.projectsDirOverride)
      : discoverSessions(options.projectsDirOverride);

    const filtered = options.session
      ? discovered.filter((s) => s.sessionId === options.session)
      : discovered;

    const lookup = (sessionId: string) => getStoredSession(db, sessionId);

    const plans: SessionIndexPlan[] = options.force
      ? filtered.map((s) => ({ session: s, action: 'reindex' as const, resumeFromLine: 0, storedFileSize: 0 }))
      : buildIndexPlan(filtered, lookup);

    for (const plan of plans) {
      if (plan.action === 'skip') {
        allStats.skipped++;
        continue;
      }
      try {
        const s = await indexSessionFile(db, plan);
        allStats.sessions++;
        allStats.turns += s.turns;
        allStats.toolCalls += s.toolCalls;
        allStats.toolResults += s.toolResults;
        allStats.thinkingBlocks += s.thinkingBlocks;
        allStats.scrubMatches += s.scrubMatches;
      } catch (err) {
        allStats.errors.push(`${plan.session.sessionId}: ${String(err)}`);
      }
    }
  } finally {
    db.close();
  }

  allStats.durationMs = Date.now() - startTime;
  return allStats;
}

// ---------------------------------------------------------------------------
// Public API — search
// ---------------------------------------------------------------------------

export function searchSessions(
  instanceId: string,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const db = openDatabase(instanceId);
  try {
    const topK = options.topK ?? 10;
    const contextWindow = options.contextWindow ?? 2;
    const params: (string | number)[] = [query];

    let sql: string;
    if (options.toolsOnly) {
      sql = `
        SELECT tc.id AS turn_id, t.session_id, s.agent_name, t.role, t.timestamp,
               tc.input_json AS content_text, rank AS score, t.turn_index, t.model,
               tc.tool_name
        FROM tools_fts f
        JOIN tool_calls tc ON tc.id = f.rowid
        JOIN turns t ON t.id = tc.turn_id
        JOIN sessions s ON s.session_id = t.session_id
        WHERE tools_fts MATCH ?
      `;
    } else if (options.thinkingOnly) {
      sql = `
        SELECT t.id AS turn_id, t.session_id, s.agent_name, t.role, t.timestamp,
               tb.content AS content_text, rank AS score, t.turn_index, t.model,
               NULL AS tool_name
        FROM thinking_fts f
        JOIN thinking_blocks tb ON tb.id = f.rowid
        JOIN turns t ON t.id = tb.turn_id
        JOIN sessions s ON s.session_id = t.session_id
        WHERE thinking_fts MATCH ?
      `;
    } else {
      sql = `
        SELECT t.id AS turn_id, t.session_id, s.agent_name, t.role, t.timestamp,
               t.content_text, rank AS score, t.turn_index, t.model,
               NULL AS tool_name
        FROM turns_fts f
        JOIN turns t ON t.id = f.rowid
        JOIN sessions s ON s.session_id = t.session_id
        WHERE turns_fts MATCH ?
      `;
    }

    if (options.agent) { sql += ' AND s.agent_name = ?'; params.push(options.agent); }
    if (options.after)  { sql += ' AND t.timestamp >= ?'; params.push(options.after); }
    if (options.before) { sql += ' AND t.timestamp <= ?'; params.push(options.before); }
    if (options.role)   { sql += ' AND t.role = ?';       params.push(options.role); }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(topK);

    const rows = db.prepare(sql).all(...params) as Array<Omit<SearchResult, 'context_before' | 'context_after'>>;

    // Fetch context window for each result
    const stmtCtx = db.prepare(`
      SELECT t.id AS turn_id, t.session_id, t.role, t.timestamp, t.content_text, t.turn_index
      FROM turns t
      WHERE t.session_id = ? AND t.turn_index BETWEEN ? AND ?
      ORDER BY t.turn_index
    `);

    return rows.map((row) => {
      const ctxRows = contextWindow > 0
        ? stmtCtx.all(row.session_id, row.turn_index - contextWindow, row.turn_index + contextWindow) as ContextTurn[]
        : [];
      return {
        ...row,
        tool_name: row.tool_name ?? null,
        context_before: ctxRows.filter((c) => c.turn_id < row.turn_id),
        context_after: ctxRows.filter((c) => c.turn_id > row.turn_id),
      };
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Public API — session listing
// ---------------------------------------------------------------------------

export function listSessions(
  instanceId: string,
  options: SessionListOptions = {},
): SessionRow[] {
  const db = openDatabase(instanceId);
  try {
    let sql = `
      SELECT session_id, agent_name, started_at, ended_at, model, git_branch,
             total_lines, indexed_lines, total_input_tokens, total_output_tokens,
             total_cache_read, total_cache_created, retention_tier
      FROM sessions
      WHERE 1=1
    `;
    const params: string[] = [];

    if (options.agent) { sql += ' AND agent_name = ?'; params.push(options.agent); }
    if (options.after) { sql += ' AND started_at >= ?'; params.push(options.after); }
    if (options.before) { sql += ' AND started_at <= ?'; params.push(options.before); }

    sql += ' ORDER BY started_at DESC';

    return db.prepare(sql).all(...params) as SessionRow[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Public API — session context retrieval
// ---------------------------------------------------------------------------

export function getSessionContext(
  instanceId: string,
  sessionId: string,
  options: SessionContextOptions = {},
): SessionContext {
  const db = openDatabase(instanceId);
  try {
    // summary mode
    if (options.summary) {
      const sessionRow = db.prepare(`
        SELECT session_id, agent_name, started_at, ended_at, model,
               indexed_lines AS total_turns,
               total_input_tokens, total_output_tokens
        FROM sessions WHERE session_id = ?
      `).get(sessionId) as (Omit<SessionContextSummary, 'first_turn' | 'last_turn'> & { total_turns: number }) | undefined;

      if (!sessionRow) {
        return { session_id: sessionId, mode: 'summary', summary: undefined };
      }

      const turnCols = 't.id AS turn_id, t.session_id, t.turn_index, t.role, t.timestamp, t.content_text, t.model';
      const firstTurn = db.prepare(`SELECT ${turnCols} FROM turns t WHERE t.session_id = ? ORDER BY t.turn_index ASC LIMIT 1`).get(sessionId) as SessionContextTurn | undefined ?? null;
      const lastTurn  = db.prepare(`SELECT ${turnCols} FROM turns t WHERE t.session_id = ? ORDER BY t.turn_index DESC LIMIT 1`).get(sessionId) as SessionContextTurn | undefined ?? null;

      const realCount = (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(sessionId) as { n: number }).n;

      return {
        session_id: sessionId,
        mode: 'summary',
        summary: {
          session_id: sessionRow.session_id,
          agent_name: sessionRow.agent_name,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          model: sessionRow.model,
          total_turns: realCount,
          total_input_tokens: sessionRow.total_input_tokens,
          total_output_tokens: sessionRow.total_output_tokens,
          first_turn: firstTurn,
          last_turn: lastTurn,
        },
      };
    }

    // tool-calls mode
    if (options.toolCalls) {
      const rows = db.prepare(`
        SELECT t.turn_index, t.timestamp, tc.tool_name, tc.tool_use_id, tc.input_json
        FROM tool_calls tc
        JOIN turns t ON t.id = tc.turn_id
        WHERE tc.session_id = ?
        ORDER BY t.turn_index, tc.id
      `).all(sessionId) as SessionContextToolCall[];

      return { session_id: sessionId, mode: 'tool-calls', toolCalls: rows };
    }

    // window mode (default)
    const pivot = options.turn ?? 0;
    const half  = options.window ?? 5;
    const lo    = Math.max(0, pivot - half);
    const hi    = pivot + half;

    const turns = db.prepare(`
      SELECT t.id AS turn_id, t.session_id, t.turn_index, t.role, t.timestamp, t.content_text, t.model
      FROM turns t
      WHERE t.session_id = ? AND t.turn_index BETWEEN ? AND ?
      ORDER BY t.turn_index
    `).all(sessionId, lo, hi) as SessionContextTurn[];

    return { session_id: sessionId, mode: 'window', turns };
  } finally {
    db.close();
  }
}
