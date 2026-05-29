/**
 * Tests for W12 claim ledger hooks.
 * Covers: extractClaims, detectEntity (hook-record-claim),
 *         detectPolarity, extractEntitiesFromText, isTelegramSend,
 *         extractMessageText (hook-warn-contradicting-claim).
 */

import { describe, it, expect } from 'vitest';
import {
  extractClaims,
  detectEntity,
} from '../../../src/hooks/hook-record-claim';
import {
  detectPolarity,
  extractEntitiesFromText,
  isTelegramSend,
  extractMessageText,
} from '../../../src/hooks/hook-warn-contradicting-claim';

// ---------------------------------------------------------------------------
// extractClaims
// ---------------------------------------------------------------------------

describe('extractClaims', () => {
  it('extracts a single structured claim', () => {
    const text = `claim:"forge is online" evidence:tool_call_id=abc123, snippet:"heartbeat updated: forge"`;
    const claims = extractClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0].claim_text).toBe('forge is online');
    expect(claims[0].tool_call_id).toBe('abc123');
    expect(claims[0].snippet).toBe('heartbeat updated: forge');
  });

  it('extracts multiple claims from the same text', () => {
    const text = [
      `claim:"nova is running" evidence:tool_call_id=id1, snippet:"nova heartbeat OK"`,
      `claim:"jarvis is healthy" evidence:tool_call_id=id2, snippet:"jarvis status: online"`,
    ].join('\n');
    const claims = extractClaims(text);
    expect(claims).toHaveLength(2);
    expect(claims[0].claim_text).toBe('nova is running');
    expect(claims[1].claim_text).toBe('jarvis is healthy');
  });

  it('returns empty array when no claims present', () => {
    expect(extractClaims('no claim syntax here')).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(extractClaims('')).toHaveLength(0);
  });

  it('handles snippet with special characters', () => {
    const text = `claim:"discordbot is live" evidence:tool_call_id=xyz789, snippet:"LIVE MODE confirmed"`;
    const claims = extractClaims(text);
    expect(claims[0].snippet).toBe('LIVE MODE confirmed');
  });

  it('is idempotent — calling twice returns same count', () => {
    const text = `claim:"forge is active" evidence:tool_call_id=t1, snippet:"active"`;
    expect(extractClaims(text)).toHaveLength(1);
    expect(extractClaims(text)).toHaveLength(1); // tests lastIndex reset
  });
});

// ---------------------------------------------------------------------------
// detectEntity
// ---------------------------------------------------------------------------

describe('detectEntity', () => {
  it('detects known agent names', () => {
    expect(detectEntity('forge is online')).toBe('forge');
    expect(detectEntity('nova completed review')).toBe('nova');
    expect(detectEntity('jarvis dispatched task')).toBe('jarvis');
    expect(detectEntity('atlas is stopped')).toBe('atlas');
    expect(detectEntity('hermes running')).toBe('hermes');
  });

  it('detects system entities', () => {
    expect(detectEntity('discordbot halted')).toBe('discordbot');
    expect(detectEntity('alpaca connection ok')).toBe('alpaca');
    expect(detectEntity('postgres is reachable')).toBe('postgres');
    expect(detectEntity('kill_switch armed')).toBe('kill_switch');
  });

  it('returns unknown for unrecognized entity', () => {
    expect(detectEntity('some other thing happened')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectEntity('FORGE is running')).toBe('forge');
    expect(detectEntity('Nova review done')).toBe('nova');
  });
});

// ---------------------------------------------------------------------------
// detectPolarity
// ---------------------------------------------------------------------------

describe('detectPolarity', () => {
  it('detects positive polarity', () => {
    expect(detectPolarity('forge is online')).toBe('positive');
    expect(detectPolarity('bot running healthy')).toBe('positive');
    expect(detectPolarity('task complete and done')).toBe('positive');
    expect(detectPolarity('alpaca confirmed active')).toBe('positive');
  });

  it('detects negative polarity', () => {
    expect(detectPolarity('forge is offline')).toBe('negative');
    expect(detectPolarity('bot stopped and down')).toBe('negative');
    expect(detectPolarity('task failed with error')).toBe('negative');
    expect(detectPolarity('broker unreachable')).toBe('negative');
  });

  it('returns neutral when no polarity words', () => {
    expect(detectPolarity('forge processed a signal today')).toBe('neutral');
    expect(detectPolarity('')).toBe('neutral');
  });

  it('returns neutral when both positive and negative present', () => {
    expect(detectPolarity('forge was online but now failed')).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesFromText
// ---------------------------------------------------------------------------

describe('extractEntitiesFromText', () => {
  it('finds multiple entities in text', () => {
    const text = 'forge and nova are both running';
    const entities = extractEntitiesFromText(text);
    expect(entities).toContain('forge');
    expect(entities).toContain('nova');
  });

  it('returns empty array when no entities', () => {
    expect(extractEntitiesFromText('no agents mentioned')).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(extractEntitiesFromText('JARVIS is online')).toContain('jarvis');
  });

  it('detects all fleet agents', () => {
    const text = 'jarvis forge nova atlas hermes echo discordbot';
    const entities = extractEntitiesFromText(text);
    expect(entities).toContain('jarvis');
    expect(entities).toContain('forge');
    expect(entities).toContain('nova');
    expect(entities).toContain('atlas');
    expect(entities).toContain('hermes');
    expect(entities).toContain('echo');
    expect(entities).toContain('discordbot');
  });
});

// ---------------------------------------------------------------------------
// isTelegramSend
// ---------------------------------------------------------------------------

describe('isTelegramSend', () => {
  it('detects send-telegram command', () => {
    expect(isTelegramSend('cortextos bus send-telegram 12345 "message"')).toBe(true);
  });

  it('detects send-message command', () => {
    expect(isTelegramSend("cortextos bus send-message jarvis normal 'hello'")).toBe(true);
  });

  it('returns false for other bash commands', () => {
    expect(isTelegramSend('ls -la')).toBe(false);
    expect(isTelegramSend('cortextos bus update-heartbeat "online"')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe('extractMessageText', () => {
  it('extracts double-quoted message from send-telegram', () => {
    const cmd = 'cortextos bus send-telegram 12345 "forge is online and healthy"';
    expect(extractMessageText(cmd)).toBe('forge is online and healthy');
  });

  it('extracts single-quoted message from send-message', () => {
    const cmd = "cortextos bus send-message jarvis normal 'nova completed review'";
    expect(extractMessageText(cmd)).toBe('nova completed review');
  });

  it('falls back to full command when no quoted message found', () => {
    const cmd = 'some-other-command noarg';
    expect(extractMessageText(cmd)).toBe(cmd);
  });
});
