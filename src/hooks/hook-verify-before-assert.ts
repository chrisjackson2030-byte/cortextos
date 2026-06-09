/**
 * hook-verify-before-assert.ts — PreToolUse hook (verify-before-assert BLOCK, FIX 1).
 *
 * Fires before a Bash send-telegram / send-message. If the outbound text makes a
 * MAJOR CLAIM (a verdict / status / number-as-fact) to B but NO source was queried
 * recently (per source_log.db, written by hook-record-source-query), it BLOCKS the
 * send (decision:'deny') with feedback telling the agent to query the source first.
 *
 * This stops the failure class where an agent asserts something (e.g. "band is real,
 * fund it") for hours without reading the on-disk verdict that contradicts it.
 *
 * ALLOWS when: no major claim, OR a recent source-query exists, OR the message cites
 * a source inline (file path / "verified via" / db/api ref).
 *
 * CRITICAL SAFETY: default-ALLOW on ANY error / ambiguity / timeout / missing db —
 * never lock out messaging (bad-news + incident sends MUST get through).
 */

import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

const RECENT_MINUTES = 10;

// Major-claim vocabulary
const VERDICT_WORDS = [
  'fund', 'fundable', 'survives', 'survive', 'proven', 'profitable', 'edge',
  'win-rate', 'win rate', 'breakeven', 'mirage', 'alpha', 'significant',
];
const STATUS_WORDS = [
  'done', 'verified', 'complete', 'completed', 'deployed', 'passed', 'fixed',
  'confirmed', 'resolved', 'reconciled', 'closed',
];
// A number presented as fact: a %, a $amount, or a decimal/sigma/x-multiple.
const NUMBER_FACT = /(\$\s?\d|\d+(?:\.\d+)?\s?%|\bz=|\bp=|\bsigma\b|σ|\bWFE\b|\d+(?:\.\d+)?x\b|win\s+\d)/i;

// Capability / existence claims (B-requested 2026-06-03). These were the failure class for
// the options "never traded" and the "can't control your screen" / "impossible" incidents —
// factual assertions about whether something happened or is possible, which MUST be source-checked.
// Apostrophes are stripped by detectMajorClaim's word-tokenizer, so these are tested against raw text.
const CAPABILITY_CLAIM = /\bcan(?:'?t|not)\b|\bunable to\b|\bimpossible\b/i;
const EXISTENCE_CLAIM = /\bnever\s+traded\b|\b(?:no|zero)\s+trades?\b|\bdidn'?t\s+trade\b|\bnever\s+(?:ran|fired|executed|placed)\b/i;

// Bad-news / incident vocabulary. The failure class this hook targets is unverified
// POSITIVE over-assertion ("band is real, fund it"). A negative/bad-news send is the SAFE
// direction and must NEVER be suppressed — so it is always allowed (err toward allow).
const BAD_NEWS_WORDS = [
  'failed', 'fail', 'fails', 'broken', 'down', 'crash', 'crashed', 'error', 'incident',
  'halt', 'halted', 'armed', 'stopped', 'kill switch', 'kill-switch', 'lost', 'losing',
  'loss', 'bug', 'wrong', 'mismatch', 'discrepancy', 'breach', 'stale', 'not fund',
  'do not fund', "don't fund", 'no real money', 'mirage', 'breakeven', 'killed',
];

// Inline source citations that make a claim self-justifying.
const INLINE_CITATION = [
  /\bverified\s+(?:via|on|by|myself)\b/i,
  /\bget_balance\b/i, /\bget_order\b/i, /\bget_settlements\b/i, /\bis_armed\b/i,
  /\bdeliverables\//i, /\bscripts\//i, /\bmemory\//i,
  /\.db\b/i, /\.json\b/i, /\.py\b/i, /\.md\b/i, /\.ts\b/i,
  /\bsqlite3\b/i, /\bfill_count_fp\b/i, /\bsettlements?\b/i, /\borderbook_snapshots\b/i,
  /\bper (?:disk|the db|the log|the api)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

export function isTelegramSend(command: string): boolean {
  return /\bsend-telegram\b/.test(command) || /\bsend-message\b/.test(command);
}

export function extractMessageText(command: string): string {
  const dq = command.match(/send-(?:telegram|message)\s+\S+(?:\s+\S+)?\s+"([\s\S]+)"/);
  if (dq) return dq[1];
  const sq = command.match(/send-(?:telegram|message)\s+\S+(?:\s+\S+)?\s+'([\s\S]+)'/);
  if (sq) return sq[1];
  return command;
}

/** True if the text makes a major claim (verdict / status / number-as-fact). */
export function detectMajorClaim(text: string): { matched: boolean; term: string } {
  const lower = text.toLowerCase();
  const words = new Set(lower.replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean));
  const hasWord = (w: string) => (w.includes(' ') || w.includes('-') ? lower.includes(w) : words.has(w));
  for (const w of VERDICT_WORDS) if (hasWord(w)) return { matched: true, term: w };
  for (const w of STATUS_WORDS) if (hasWord(w)) return { matched: true, term: w };
  if (EXISTENCE_CLAIM.test(text)) return { matched: true, term: 'existence-claim' };
  if (CAPABILITY_CLAIM.test(text)) return { matched: true, term: 'capability-claim' };
  if (NUMBER_FACT.test(text)) return { matched: true, term: 'number-as-fact' };
  return { matched: false, term: '' };
}

/** True if the message cites a source inline (file path / verified-via / db/api ref). */
export function citesSourceInline(text: string): boolean {
  return INLINE_CITATION.some(re => re.test(text));
}

/** True if the message is bad-news / an incident report — always allowed (never suppress). */
export function isBadNews(text: string): boolean {
  const lower = text.toLowerCase();
  return BAD_NEWS_WORDS.some(w => lower.includes(w));
}

// RELEVANCE check (added 2026-06-03, beyond the literal "any recent source-query" spec).
// VERIFIED REASON: a count-only gate is defeated by normal tool use — there are almost always
// SOME recent reads (e.g. 7 unrelated source-queries during this very session), so "any recent
// source" would have ALLOWED the false "band is fundable" claim (the source-queries were of hook
// files, not the band verdict). The gate must require a recent source-query about the claim's
// SUBJECT. Stopwords = the claim/status vocabulary + common words, so the salient tokens are the
// subject nouns (band, options, sidewinder, kalshi, ...).
const STOP = new Set<string>([
  ...VERDICT_WORDS, ...STATUS_WORDS, ...BAD_NEWS_WORDS,
  'never', 'traded', 'trade', 'trades', 'trading', 'didnt', 'cannot', 'cant',
  'impossible', 'unable', 'zero', 'real', 'money', 'this', 'that', 'with', 'from',
  // generic domain-noise: too common to identify a subject -> gate must key on the SPECIFIC name
  'strategy', 'strategies', 'system', 'systems', 'model', 'models', 'market', 'markets',
  'account', 'accounts', 'signal', 'signals', 'data', 'price', 'prices', 'result', 'results',
  'have', 'will', 'your', 'here', 'there', 'what', 'when', 'just', 'only', 'been',
  'were', 'they', 'them', 'then', 'than', 'also', 'about', 'into', 'over', 'more',
  'most', 'some', 'like', 'these', 'those', 'their', 'would', 'could', 'should',
  'after', 'before', 'still', 'which', 'because', 'first',
].map(s => s.replace(/[^a-z]/g, '')).filter(s => s.length >= 4));

// H3 FIX (red-team 2026-06-03): tickers/short subjects (BTC, ETH, SPY...) are <4 chars, so they
// were dropped, leaving zero salient tokens -> fell through to the count-only ALLOW that any read
// satisfies. Keep known tickers/short subjects salient.
const SHORT_SUBJECTS = new Set([
  'btc', 'eth', 'sol', 'xrp', 'ada', 'doge', 'spy', 'qqq', 'spx', 'ndx', 'vix', 'es', 'nq',
  'iwm', 'tlt', 'gld', 'dia', 'kxbtc', 'kxeth', 'vrp', 'pm',
]);

/** Subject tokens of a claim: alphabetic words len>=4 (or known tickers) not in the stopword set. */
export function salientTokens(text: string): string[] {
  const toks = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(t => (t.length >= 4 || SHORT_SUBJECTS.has(t)) && !/^\d+$/.test(t) && !STOP.has(t));
  return Array.from(new Set(toks));
}

/** True if any recent source-query snippet mentions any salient subject token of the claim. */
export function hasRelevantSource(tokens: string[], snippets: string[]): boolean {
  if (tokens.length === 0) return false;          // no subject -> caller falls back to count
  const blob = snippets.join(' \n ').toLowerCase();
  return tokens.some(t => blob.includes(t));
}

// H4 FIX (red-team 2026-06-03): the old inline-cite exemption accepted ANY file extension / bare
// "memory/" / "verified via" with no link to the claim — so "band is fundable (see notes.md)"
// passed citing an unrelated file. Now an inline cite only exempts if a CITED PATH actually mentions
// the claim's subject. Generic claims (no subject tokens) still accept any concrete cite.
export function citesRelevantSourceInline(text: string): boolean {
  const paths = text.match(/[\w./-]+\.(?:md|json|jsonl|py|ts|db|csv|log)\b/gi) || [];
  if (paths.length === 0) return /\bverified\s+(?:via|on|by)\b/i.test(text) && salientTokens(text).length === 0;
  // Derive subject tokens from PROSE with the cited paths removed, so a filename can't satisfy
  // itself (the "see notes.md" -> token "notes" -> matches "notes.md" self-match bug, 2026-06-03).
  let prose = text;
  for (const p of paths) prose = prose.split(p).join(' ');
  const subj = salientTokens(prose);
  if (subj.length === 0) return true;             // a cite + no real subject -> accept
  const blob = paths.join(' ').toLowerCase();
  return subj.some(t => blob.includes(t));        // a cited PATH must name the claim's subject
}

/**
 * Core decision. DENY iff a major claim is made with NO recent source-query AND no
 * inline citation. recentSourceCount < 0 = "unknown/error" -> fail-open ALLOW.
 */
export function decideVerify(opts: {
  hasMajorClaim: boolean;
  recentSourceCount: number;
  citesInline: boolean;
}): 'allow' | 'deny' {
  if (opts.recentSourceCount < 0) return 'allow';   // fail-open on unknown/error
  if (!opts.hasMajorClaim) return 'allow';
  if (opts.citesInline) return 'allow';
  if (opts.recentSourceCount >= 1) return 'allow';
  return 'deny';
}

/**
 * Proof-of-fire log. Every time the gate FIRES on a major claim it appends one line to
 * logs/<agent>/verify-gate.log with the outcome (DENY/ALLOW) + reason — this is the
 * auditable artifact (B can `tail` it next week to prove the gate ran). Never throws.
 */
function logGate(env: { ctxRoot: string; agentName: string },
                 decision: 'DENY' | 'ALLOW', term: string, reason: string, recentSource: number): void {
  try {
    const dir = join(env.ctxRoot, 'logs', env.agentName);
    mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${decision} trigger="${term}" reason=${reason} recent_source=${recentSource}\n`;
    appendFileSync(join(dir, 'verify-gate.log'), line);
  } catch { /* logging must never block a send */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 4_000)),
    ]);
    if (!raw.trim()) { process.exit(0); return; }

    let payload: Record<string, any> = {};
    try { payload = JSON.parse(raw); } catch { process.exit(0); return; }

    const toolName = payload.tool_name || '';
    const command: string = payload.tool_input?.command || '';
    if (toolName !== 'Bash' || !isTelegramSend(command)) { process.exit(0); return; }

    const text = extractMessageText(command);
    const claim = detectMajorClaim(text);
    if (!claim.matched) { process.exit(0); return; }       // no major claim -> gate doesn't fire, allow silently

    // From here the gate has FIRED on a major claim — every path below logs its outcome.
    // C3 FIX (red-team 2026-06-03): the bad-news exemption used to ALLOW any message containing a
    // negative word, BEFORE the relevance check — so "band is fundable, no loss, fund it" sailed
    // through (contains "loss"). That is the exact false-positive class the gate exists to stop.
    // Now bad-news only exempts a PURELY-NUMERIC report (e.g. "lost $40") — to preserve fast
    // incident/loss reporting — NOT verdict/status/existence/capability claims, which must still
    // pass the relevance/source check even when wrapped in bad-news framing.
    if (isBadNews(text) && claim.term === 'number-as-fact') {
      logGate(env, 'ALLOW', claim.term, 'bad-news-numeric-exempt', -1);
      process.exit(0); return;
    }
    const tokens = salientTokens(text);
    if (citesRelevantSourceInline(text)) {                 // cite that NAMES the subject -> allow
      logGate(env, 'ALLOW', claim.term, 'inline-cite-relevant', -1);
      process.exit(0); return;
    }

    // Pull recent source-query snippets. Any failure -> recentSourceCount = -1 (fail-open).
    let recentSourceCount = -1;
    let recentSnippets: string[] = [];
    try {
      const dbPath = join(env.stateDir, 'source_log.db');
      if (existsSync(dbPath)) {
        const { default: Database } = await import('better-sqlite3');
        const db = new Database(dbPath, { readonly: true });
        const cutoff = new Date(Date.now() - RECENT_MINUTES * 60 * 1000).toISOString();
        const rows = db.prepare('SELECT snippet FROM source_queries WHERE ts > ? ORDER BY ts DESC LIMIT 50')
          .all(cutoff) as { snippet: string }[];
        // C2 (full): match relevance against the CONTENT that was actually READ, not the command
        // string. A snippet is "cmd || CONTENT: <content>"; use the content part when present so
        // merely NAMING a subject in a command (e.g. `grep band`) can't satisfy a claim.
        // Only the CONTENT actually read counts for relevance. A content-less row (no CONTENT:
        // marker — i.e. the harness captured no tool_response) contributes NOTHING, so merely
        // NAMING a subject in a command can never satisfy a claim (red-team C2 close, 2026-06-03).
        // Recent rows reliably carry CONTENT now; content-less rows are rare and safely ignored.
        recentSnippets = rows.map(r => {
          const s = r.snippet || '';
          const i = s.indexOf('CONTENT:');
          return i >= 0 ? s.slice(i + 'CONTENT:'.length) : '';
        });
        recentSourceCount = recentSnippets.length;
        db.close();
      } else {
        recentSourceCount = 0;   // db exists-check failed but no error: treat as "no recent source"
      }
    } catch {
      recentSourceCount = -1;    // any DB error -> fail-open
    }

    if (recentSourceCount < 0) {                            // fail-open on unknown/error
      logGate(env, 'ALLOW', claim.term, 'fail-open', recentSourceCount);
      process.exit(0); return;
    }

    // RELEVANCE-aware decision (the working gate). If the claim has subject tokens, require a
    // recent source-query that MENTIONS one of them; a generic claim (no subject) falls back to
    // the spec's count>=1. This is what would have caught "band is fundable" with no band read.
    // (tokens computed above, before the inline-cite check.)
    let decision: 'allow' | 'deny';
    let reason: string;
    if (tokens.length > 0) {
      const relevant = hasRelevantSource(tokens, recentSnippets);
      decision = relevant ? 'allow' : 'deny';
      reason = relevant ? 'relevant-source' : `no-source-for-subject[${tokens.slice(0, 4).join(',')}]`;
    } else {
      decision = recentSourceCount >= 1 ? 'allow' : 'deny';
      reason = recentSourceCount >= 1 ? 'recent-source-generic' : 'no-recent-source-query';
    }
    if (decision === 'allow') {
      logGate(env, 'ALLOW', claim.term, reason, recentSourceCount);
      process.exit(0); return;
    }
    logGate(env, 'DENY', claim.term, reason, recentSourceCount);

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        decision: 'deny',
        feedback:
          `VERIFY-BEFORE-ASSERT BLOCK: this message asserts a major claim ("${claim.term}") about ` +
          `[${tokens.slice(0, 4).join(', ')}], but no source-query in the last ${RECENT_MINUTES} min ` +
          `touched that subject, and the message cites no source inline. Query THE RELEVANT source ` +
          `(Read the verdict file / DB / API / kb-query for that subject), THEN resend — or cite it ` +
          `inline (file path, "verified via", db/api ref).`,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);
  } catch {
    process.exit(0);   // never block on error
  }
}

main().catch(() => process.exit(0));
