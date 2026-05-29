/**
 * hook-warn-contradicting-claim.ts — PreToolUse hook (W12 Claim Ledger).
 *
 * Fires when an agent is about to execute a Bash command that sends a
 * Telegram message (send-telegram or send-message). Checks the outbound
 * message text against recent claims in claims.db for the same entity.
 *
 * If a contradiction is detected (positive claim within 15 min vs negative
 * claim being sent now, or vice versa), prepends [CONTRADICTION WARNING]
 * to the hook's feedback so the agent can review before sending.
 *
 * Warning only — never blocks the send. The agent can override.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

// ---------------------------------------------------------------------------
// Polarity word lists for contradiction detection
// ---------------------------------------------------------------------------

const POSITIVE_WORDS = new Set([
  'online', 'running', 'healthy', 'active', 'up', 'complete', 'done',
  'pass', 'passed', 'good', 'ok', 'alive', 'started', 'launched', 'armed',
  'confirmed', 'verified', 'success', 'succeeded', 'green', 'ready', 'live',
]);

const NEGATIVE_WORDS = new Set([
  'offline', 'stopped', 'down', 'dead', 'failed', 'error', 'missing',
  'broken', 'absent', 'silent', 'unresponsive', 'crashed', 'stale', 'halt',
  'halted', 'blocked', 'unarmed', 'not running', 'not found', 'unknown',
  'unreachable',
]);

const KNOWN_ENTITIES = [
  'jarvis', 'forge', 'nova', 'atlas', 'hermes', 'echo',
  'discordbot', 'broker', 'alpaca', 'postgres', 'redis',
  'kill_switch', 'heartbeat',
];

const LOOKBACK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

export function detectPolarity(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  // Use word-set for single-word matches to avoid substring false-positives
  // (e.g., 'ok' inside 'broker'). Multi-word phrases use substring match.
  const wordSet = new Set(lower.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean));
  const matchWord = (w: string) =>
    w.includes(' ') ? lower.includes(w) : wordSet.has(w);
  const hasPos = [...POSITIVE_WORDS].some(matchWord);
  const hasNeg = [...NEGATIVE_WORDS].some(matchWord);
  if (hasPos && !hasNeg) return 'positive';
  if (hasNeg && !hasPos) return 'negative';
  return 'neutral';
}

export function extractEntitiesFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_ENTITIES.filter(e => lower.includes(e));
}

export function isTelegramSend(command: string): boolean {
  return /\bsend-telegram\b/.test(command) || /\bsend-message\b/.test(command);
}

export function extractMessageText(command: string): string {
  // Extract quoted message argument from: send-telegram <chat_id> "message"
  // or: send-message <agent> <priority> 'message'
  const dqMatch = command.match(/send-(?:telegram|message)\s+\S+(?:\s+\S+)?\s+"([^"]+)"/);
  if (dqMatch) return dqMatch[1];
  const sqMatch = command.match(/send-(?:telegram|message)\s+\S+(?:\s+\S+)?\s+'([^']+)'/);
  if (sqMatch) return sqMatch[1];
  return command;
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

    if (!raw.trim()) { process.exit(0); return; }

    let payload: Record<string, any> = {};
    try { payload = JSON.parse(raw); } catch { process.exit(0); return; }

    const toolName = payload.tool_name || '';
    const command: string = payload.tool_input?.command || '';

    // Only fire on Bash tool calls that send Telegram messages
    if (toolName !== 'Bash' || !isTelegramSend(command)) {
      process.exit(0);
      return;
    }

    const messageText = extractMessageText(command);
    const newPolarity = detectPolarity(messageText);

    // Neutral messages can't contradict — skip
    if (newPolarity === 'neutral') { process.exit(0); return; }

    const entities = extractEntitiesFromText(messageText);
    if (entities.length === 0) { process.exit(0); return; }

    const claimsDbPath = join(env.stateDir, 'claims.db');
    if (!existsSync(claimsDbPath)) { process.exit(0); return; }

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(claimsDbPath, { readonly: true });

    const cutoff = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000).toISOString();

    const warnings: string[] = [];

    for (const entity of entities) {
      const rows = db.prepare(
        `SELECT claim_text, evidence_snippet, ts FROM agent_claims
         WHERE entity = ? AND ts > ?
         ORDER BY ts DESC LIMIT 5`
      ).all(entity, cutoff) as Array<{ claim_text: string; evidence_snippet: string; ts: string }>;

      for (const row of rows) {
        const prevPolarity = detectPolarity(row.claim_text);
        if (prevPolarity === 'neutral') continue;
        if (prevPolarity !== newPolarity) {
          const snippet = row.evidence_snippet ? ` (evidence: "${row.evidence_snippet}")` : '';
          warnings.push(
            `entity="${entity}" prev="${row.claim_text.slice(0, 80)}"${snippet} @ ${row.ts.slice(11, 19)}Z`
          );
        }
      }
    }

    db.close();

    if (warnings.length === 0) { process.exit(0); return; }

    // Output feedback — Claude Code injects this as a [Feedback] context block
    // so the agent sees the warning before the send executes.
    const warningText = [
      `[CONTRADICTION WARNING] The Telegram message you are about to send may contradict a recent claim in your claim ledger (last ${LOOKBACK_MINUTES} min):`,
      ...warnings.map(w => `  • ${w}`),
      'Review the evidence before sending. If the new claim is correct, the prior one is stale — continue normally.',
    ].join('\n');

    // Claude Code PreToolUse feedback format
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        decision: 'allow',
        feedback: warningText,
      },
    };

    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);

  } catch {
    // Never block the tool call on any error
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
