import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import { resolveEnv } from '../utils/env.js';
import type { CompletionEnvelope } from '../types/index.js';

const RUNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    trace_id TEXT,
    run_token TEXT,
    status TEXT,
    result TEXT,
    artifacts TEXT,
    blockers TEXT,
    next_action TEXT,
    emitted_at TEXT,
    created_at TEXT
  )
`;

const TERMINAL_STATUSES = new Set(['done', 'failed', 'blocked']);

export interface RunRecord {
  run_id: string;
  trace_id: string | null;
  run_token: string;
  status: string;
  result: string | null;
  artifacts: string[];
  blockers: string[];
  next_action: string | null;
  emitted_at: string | null;
  created_at: string;
}

export interface RunStartRecord {
  run_id: string;
  run_token: string;
  trace_id: string | null;
}

type RawRunRow = {
  run_id: string;
  trace_id: string | null;
  run_token: string;
  status: string;
  result: string | null;
  artifacts: string | null;
  blockers: string | null;
  next_action: string | null;
  emitted_at: string | null;
  created_at: string;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function analyticsDir(): string {
  const env = resolveEnv();
  const orgBase = env.org ? join(env.ctxRoot, 'orgs', env.org) : env.ctxRoot;
  return join(orgBase, 'analytics');
}

function serializeList(values?: string[]): string | null {
  return values && values.length > 0 ? JSON.stringify(values) : null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toRunRecord(row: RawRunRow | undefined): RunRecord | null {
  if (!row) return null;
  return {
    run_id: row.run_id,
    trace_id: row.trace_id,
    run_token: row.run_token,
    status: row.status,
    result: row.result,
    artifacts: parseList(row.artifacts),
    blockers: parseList(row.blockers),
    next_action: row.next_action,
    emitted_at: row.emitted_at,
    created_at: row.created_at,
  };
}

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T | null {
  let db: InstanceType<typeof Database> | null = null;
  try {
    const dir = analyticsDir();
    ensureDir(dir);
    db = new Database(join(dir, 'runs.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.exec(RUNS_SCHEMA);
    return fn(db);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('run_token mismatch')) {
      throw err;
    }
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export function startRun(traceId?: string): RunStartRecord | null {
  return withDb((db) => {
    const run_id = `run_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const run_token = randomBytes(8).toString('hex');
    const trace_id = traceId ?? null;
    const created_at = nowIso();
    db.prepare(`
      INSERT INTO runs (
        run_id, trace_id, run_token, status, result, artifacts, blockers, next_action, emitted_at, created_at
      ) VALUES (?, ?, ?, 'running', NULL, NULL, NULL, NULL, NULL, ?)
    `).run(run_id, trace_id, run_token, created_at);
    return { run_id, run_token, trace_id };
  });
}

export function completeRun(envelope: CompletionEnvelope): RunRecord | null {
  const result = withDb((db) => {
    const select = db.prepare('SELECT * FROM runs WHERE run_id = ?');
    const existing = toRunRecord(select.get(envelope.run_id) as RawRunRow | undefined);
    if (!existing) return null;
    if (TERMINAL_STATUSES.has(existing.status)) return existing;
    if (envelope.signature !== existing.run_token) {
      throw new Error(`run_token mismatch for ${envelope.run_id}`);
    }

    db.prepare(`
      UPDATE runs
      SET status = ?, result = ?, artifacts = ?, blockers = ?, next_action = ?, emitted_at = ?
      WHERE run_id = ?
    `).run(
      envelope.status,
      envelope.result ?? null,
      serializeList(envelope.artifacts),
      serializeList(envelope.blockers),
      envelope.next_action ?? null,
      envelope.emitted_at,
      envelope.run_id,
    );

    return toRunRecord(select.get(envelope.run_id) as RawRunRow | undefined);
  });

  if (result === null) return null;
  return result;
}

export function getRun(run_id: string): RunRecord | null {
  return withDb((db) => toRunRecord(
    db.prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id) as RawRunRow | undefined,
  ));
}

export function getRunByTrace(trace_id: string): RunRecord | null {
  return withDb((db) => toRunRecord(
    db.prepare('SELECT * FROM runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1').get(trace_id) as RawRunRow | undefined,
  ));
}
