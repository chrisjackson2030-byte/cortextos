/**
 * hook-record-source-query.ts — PostToolUse hook (verify-before-assert, FIX 1).
 *
 * Records that "a source was queried" into state/<agent>/source_log.db on every
 * Read, and on every Bash command that reads data (sqlite3 / get_balance /
 * get_order / get_settlements / cat / grep / curl / wget / python reading a
 * file or API). The companion PreToolUse hook (hook-verify-before-assert) reads
 * this ledger to decide whether an outbound major claim was backed by a recent
 * source-query.
 *
 * Never blocks — any error is silently caught and the hook exits 0.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

// Bash commands that constitute a "source query" (reading data/state/API).
const SOURCE_QUERY_PATTERNS: RegExp[] = [
  /\bsqlite3\b/,
  /\bget_balance\b/, /\bget_order\b/, /\bget_settlements\b/, /\bget_positions\b/,
  /\bcat\b/, /\bgrep\b/, /\brg\b/, /\bhead\b/, /\btail\b/, /\bsed\b/, /\bawk\b/,
  /\bcurl\b/, /\bwget\b/,
  /\burllib\b/, /\brequests\.\b/, /\bopen\(/, /\bjson\.load/, /\.fetchone\(/, /\.fetchall\(/,
  /\.execute\(/, /PRAGMA\b/i,
  /\.db\b/, /\.json\b/, /\.jsonl\b/,
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_queries (
    id     TEXT PRIMARY KEY,
    agent  TEXT NOT NULL,
    tool   TEXT NOT NULL,
    snippet TEXT,
    ts     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_source_queries_ts ON source_queries(ts);
`;

// ---------------------------------------------------------------------------
// Helper — exported for tests
// ---------------------------------------------------------------------------

/** Does this tool call read a source? Returns the match + a short snippet to log. */
export function isSourceQuery(toolName: string, toolInput: Record<string, any>): { match: boolean; snippet: string } {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const tgt = toolInput?.file_path || toolInput?.path || toolInput?.pattern || '';
    return { match: true, snippet: `${toolName} ${String(tgt)}`.slice(0, 200) };
  }
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    if (SOURCE_QUERY_PATTERNS.some(re => re.test(cmd))) {
      return { match: true, snippet: cmd.slice(0, 200) };
    }
  }
  return { match: false, snippet: '' };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 5_000)),
    ]);
    if (!raw.trim()) return;

    let payload: Record<string, any> = {};
    try { payload = JSON.parse(raw); } catch { return; }

    const toolName = payload.tool_name || '';
    const toolInput = payload.tool_input || {};
    const { match, snippet } = isSourceQuery(toolName, toolInput);
    if (!match) return;

    // C2 FIX (red-team 2026-06-03): also record a chunk of what was actually READ (the tool
    // RESPONSE), not just the command/path. The relevance gate matches the claim subject against
    // this snippet — recording only the command let "cat band-notes.txt" fake-satisfy a band claim
    // without reading the real verdict. Now the actual file/output content must contain the subject.
    let respText = '';
    try {
      const resp = (payload as any).tool_response ?? (payload as any).tool_result;
      if (typeof resp === 'string') respText = resp;
      else if (resp && typeof resp === 'object') {
        // Prefer the actual BODY. The Read tool_response is {type, file:{filePath, content}} —
        // use resp.file.content so the kept CONTENT is the body, NOT the filePath envelope
        // (else a Read of a subject-named file matches on the path even if the body is off-topic;
        // red-team residual close, 2026-06-03).
        respText = typeof resp.content === 'string' ? resp.content
                 : (resp.file && typeof resp.file.content === 'string') ? resp.file.content
                 : typeof resp.stdout === 'string' ? resp.stdout
                 : JSON.stringify(resp);
      }
    } catch { /* ignore */ }
    const fullSnippet = (snippet + (respText ? ' || CONTENT: ' + respText.replace(/\s+/g, ' ') : '')).slice(0, 1500);

    const dbPath = join(env.stateDir, 'source_log.db');
    mkdirSync(env.stateDir, { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO source_queries (id, agent, tool, snippet) VALUES (?, ?, ?, ?)')
      .run(generateId(), env.agentName, toolName, fullSnippet);
    db.close();
  } catch {
    // Never fail — hook must not block Claude Code
  }
}

main().catch(() => process.exit(0));
