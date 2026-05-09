import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// JSONL Session Transcript Indexer — SQLite Schema
// ---------------------------------------------------------------------------
//
// Phase 1 skeleton: schema creation, WAL mode setup, table + index + FTS5
// + trigger definitions.  Does NOT depend on better-sqlite3 at import time
// (the dependency is not yet in package.json).  Instead, this module exports
// schema DDL strings and a `createDatabase` function whose `db` parameter
// is duck-typed to the subset of the better-sqlite3 API we need.  Forge
// will wire the actual import in Phase 2.
//
// Database location: ~/.cortextos/<instance_id>/indexer/sessions.db
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the better-sqlite3 Database interface that this module
 * needs.  Using a structural type instead of importing the package keeps the
 * build green until better-sqlite3 is added to package.json.
 */
export interface DatabaseHandle {
  pragma(source: string): unknown;
  exec(source: string): void;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory that holds the indexer database for a given
 * cortextOS instance.
 */
export function indexerDir(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'indexer');
}

/**
 * Resolve the full path to the SQLite database file.
 */
export function indexerDbPath(instanceId: string): string {
  return join(indexerDir(instanceId), 'sessions.db');
}

/**
 * Ensure the indexer directory exists on disk.
 */
export function ensureIndexerDir(instanceId: string): string {
  const dir = indexerDir(instanceId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// DDL — exported as a constant so tests can assert against it without
// needing a live database.
// ---------------------------------------------------------------------------

/**
 * Complete DDL for the indexer database.  Idempotent (IF NOT EXISTS on
 * every CREATE).  Order matters: base tables before FTS5 virtual tables
 * before triggers, because triggers reference FTS tables and FTS tables
 * reference base tables via content= syncing.
 */
export const SCHEMA_DDL = `
-- =========================================================================
-- Core session registry
-- =========================================================================
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  model         TEXT,
  git_branch    TEXT,
  cwd           TEXT,
  total_lines   INTEGER DEFAULT 0,
  indexed_lines INTEGER DEFAULT 0,
  file_size     INTEGER DEFAULT 0,
  file_mtime    TEXT,
  total_input_tokens   INTEGER DEFAULT 0,
  total_output_tokens  INTEGER DEFAULT 0,
  total_cache_read     INTEGER DEFAULT 0,
  total_cache_created  INTEGER DEFAULT 0,
  retention_tier            TEXT NOT NULL DEFAULT 'full',
  retention_tier_changed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_name);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

-- =========================================================================
-- Individual conversation turns (the searchable content)
-- =========================================================================
CREATE TABLE IF NOT EXISTS turns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  uuid          TEXT NOT NULL,
  parent_uuid   TEXT,
  turn_index    INTEGER NOT NULL,
  role          TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  content_text  TEXT,
  has_tool_use  INTEGER DEFAULT 0,
  stop_reason   TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  model         TEXT,
  line_offset   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
CREATE INDEX IF NOT EXISTS idx_turns_role ON turns(role);

-- =========================================================================
-- Tool calls extracted from assistant messages
-- =========================================================================
CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       INTEGER NOT NULL REFERENCES turns(id),
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  tool_use_id   TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  input_json    TEXT,
  timestamp     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

-- =========================================================================
-- Tool results extracted from user messages
-- =========================================================================
CREATE TABLE IF NOT EXISTS tool_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_use_id   TEXT NOT NULL,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  content_text  TEXT,
  is_error      INTEGER DEFAULT 0,
  timestamp     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_results_use_id ON tool_results(tool_use_id);

-- =========================================================================
-- Thinking blocks extracted from assistant messages
-- =========================================================================
CREATE TABLE IF NOT EXISTS thinking_blocks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id          INTEGER NOT NULL REFERENCES turns(id),
  session_id       TEXT NOT NULL REFERENCES sessions(session_id),
  sequence_in_turn INTEGER NOT NULL,
  content          TEXT NOT NULL,
  indexed_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thinking_turn ON thinking_blocks(turn_id);
CREATE INDEX IF NOT EXISTS idx_thinking_session ON thinking_blocks(session_id);

-- =========================================================================
-- Entities (populated by Phase 5 second-pass extractor)
-- =========================================================================
CREATE TABLE IF NOT EXISTS entities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  turn_id       INTEGER NOT NULL REFERENCES turns(id),
  entity_type   TEXT NOT NULL,
  entity_value  TEXT NOT NULL,
  context       TEXT,
  timestamp     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_value ON entities(entity_value);

-- =========================================================================
-- FTS5 virtual tables — external-content mode
-- =========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content_text,
  content='turns',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  input_json,
  content='tool_calls',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS thinking_fts USING fts5(
  content,
  content='thinking_blocks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- =========================================================================
-- FTS sync triggers
-- =========================================================================
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content_text)
    VALUES (new.id, new.content_text);
END;

CREATE TRIGGER IF NOT EXISTS thinking_blocks_ai AFTER INSERT ON thinking_blocks BEGIN
  INSERT INTO thinking_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS tool_calls_ai AFTER INSERT ON tool_calls BEGIN
  INSERT INTO tools_fts(rowid, input_json) VALUES (new.id, new.input_json);
END;

-- =========================================================================
-- Scrub audit log — tracks what was redacted (not the secrets themselves)
-- =========================================================================
CREATE TABLE IF NOT EXISTS scrub_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  turn_id       INTEGER,
  tool_call_id  INTEGER,
  pattern       TEXT NOT NULL,
  timestamp     TEXT NOT NULL
);

-- =========================================================================
-- Cross-agent search audit log (Decision #4)
-- =========================================================================
CREATE TABLE IF NOT EXISTS search_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  querying_agent  TEXT NOT NULL,
  target_agent    TEXT,
  query_text      TEXT NOT NULL,
  result_count    INTEGER DEFAULT 0,
  timestamp       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_audit_agent ON search_audit_log(querying_agent);
CREATE INDEX IF NOT EXISTS idx_search_audit_timestamp ON search_audit_log(timestamp);
`;

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

/**
 * Apply WAL mode and execute the full schema DDL against an open database
 * handle.  Idempotent — safe to call on every startup.
 *
 * @param db  An open better-sqlite3 Database instance (or any object
 *            satisfying the DatabaseHandle interface).
 */
export function applySchema(db: DatabaseHandle): void {
  // WAL mode: concurrent readers during writes.  pragma() returns the
  // current journal_mode after the change — we don't need the return value.
  db.pragma('journal_mode = WAL');

  // Recommended performance pragmas for an append-heavy workload:
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64 MB page cache
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA_DDL);
}

/**
 * High-level helper: ensure the indexer directory exists, then apply the
 * schema to the provided database handle.  Returns the resolved database
 * file path (useful for logging).
 *
 * Callers are responsible for opening the database — this module does NOT
 * import better-sqlite3 directly.
 *
 * Typical usage (once better-sqlite3 is available):
 *
 * ```ts
 * import Database from 'better-sqlite3';
 * import { ensureIndexerDir, indexerDbPath, applySchema } from './indexer-schema.js';
 *
 * const instanceId = process.env.CTX_INSTANCE_ID!;
 * ensureIndexerDir(instanceId);
 * const db = new Database(indexerDbPath(instanceId));
 * applySchema(db);
 * ```
 */
export function initializeDatabase(db: DatabaseHandle, instanceId: string): string {
  ensureIndexerDir(instanceId);
  applySchema(db);
  return indexerDbPath(instanceId);
}
