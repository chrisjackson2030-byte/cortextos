/**
 * hook-record-claim.ts — PostToolUse hook (W12 Claim Ledger).
 *
 * Scans agent tool calls for structured claim annotations matching:
 *   claim:"<text>" evidence:tool_call_id=<id>, snippet:"<≤80 chars>"
 *
 * Each match is inserted into state/<agent>/claims.db so the
 * contradiction-warning hook can query recent claims for the same entity.
 *
 * Entities are auto-detected from claim_text: known agent names +
 * broker/system names that Jarvis frequently makes status claims about.
 *
 * Never blocks — any error is silently caught and the hook exits 0.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

// ---------------------------------------------------------------------------
// Claim pattern — must match what Jarvis is prompted to write
// ---------------------------------------------------------------------------

// Full structured claim: claim:"text" evidence:tool_call_id=abc, snippet:"xyz"
const CLAIM_PATTERN =
  /claim:"([^"]{1,500})"\s+evidence:tool_call_id=([A-Za-z0-9_\-]+),\s*snippet:"([^"]{0,80})"/g;

// Known entities Jarvis makes claims about
const KNOWN_ENTITIES = [
  'jarvis', 'forge', 'nova', 'atlas', 'hermes', 'echo',
  'discordbot', 'broker', 'alpaca', 'postgres', 'redis',
  'kill_switch', 'heartbeat',
];

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------

const CLAIMS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_claims (
    id                    TEXT PRIMARY KEY,
    agent                 TEXT NOT NULL,
    entity                TEXT NOT NULL,
    claim_text            TEXT NOT NULL,
    evidence_tool_call_id TEXT,
    evidence_snippet      TEXT,
    confidence            REAL NOT NULL DEFAULT 1.0,
    ts                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_claims_entity_ts
    ON agent_claims(entity, ts);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function detectEntity(claimText: string): string {
  const lower = claimText.toLowerCase();
  for (const entity of KNOWN_ENTITIES) {
    if (lower.includes(entity)) return entity;
  }
  return 'unknown';
}

export function extractClaims(text: string): Array<{
  claim_text: string;
  tool_call_id: string;
  snippet: string;
}> {
  const results: Array<{ claim_text: string; tool_call_id: string; snippet: string }> = [];
  CLAIM_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAIM_PATTERN.exec(text)) !== null) {
    results.push({ claim_text: m[1], tool_call_id: m[2], snippet: m[3] });
  }
  return results;
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

    // Scan tool_input (command/content) and tool_response for claim patterns
    const searchTargets: string[] = [];
    const toolInput = payload.tool_input || {};

    if (typeof toolInput.command === 'string') searchTargets.push(toolInput.command);
    if (typeof toolInput.content === 'string') searchTargets.push(toolInput.content);
    if (typeof toolInput.new_string === 'string') searchTargets.push(toolInput.new_string);
    if (typeof payload.tool_response === 'string') searchTargets.push(payload.tool_response);
    else if (typeof payload.tool_response === 'object' && payload.tool_response?.content) {
      searchTargets.push(String(payload.tool_response.content));
    }

    const fullText = searchTargets.join('\n');
    const claims = extractClaims(fullText);
    if (claims.length === 0) return;

    // Open claims DB
    const claimsDbPath = join(env.stateDir, 'claims.db');
    mkdirSync(env.stateDir, { recursive: true });

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(claimsDbPath);
    db.exec(CLAIMS_SCHEMA);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO agent_claims
        (id, agent, entity, claim_text, evidence_tool_call_id, evidence_snippet, confidence)
      VALUES (?, ?, ?, ?, ?, ?, 1.0)
    `);

    const sessionToolCallId = payload.tool_use_id || payload.tool_call_id || 'unknown';

    for (const c of claims) {
      const entity = detectEntity(c.claim_text);
      // evidence_tool_call_id: prefer annotation's value, fall back to hook's session tool id
      const toolCallId = c.tool_call_id !== 'self' ? c.tool_call_id : sessionToolCallId;
      insert.run(generateId(), env.agentName, entity, c.claim_text, toolCallId, c.snippet);
    }

    db.close();
  } catch {
    // Never fail — hook must not block Claude Code
  }
}

main().catch(() => process.exit(0));
