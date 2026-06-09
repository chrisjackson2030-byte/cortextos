/**
 * Tests for FIX 1 — verify-before-assert (hook-verify-before-assert + hook-record-source-query).
 * The 5 required scenarios + helper coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  detectMajorClaim,
  citesSourceInline,
  decideVerify,
  isBadNews,
  isTelegramSend,
  extractMessageText,
} from '../../../src/hooks/hook-verify-before-assert';
import { isSourceQuery } from '../../../src/hooks/hook-record-source-query';

// ---- The 5 required scenarios ----
describe('verify-before-assert: the 5 required scenarios', () => {
  it('(1) naked major claim, no recent source -> DENY', () => {
    const text = 'band is profitable, fund it';
    expect(detectMajorClaim(text).matched).toBe(true);          // profitable + fund
    expect(citesSourceInline(text)).toBe(false);
    expect(decideVerify({ hasMajorClaim: true, recentSourceCount: 0, citesInline: false })).toBe('deny');
  });

  it('(2) same claim AFTER a source-query -> ALLOW', () => {
    expect(decideVerify({ hasMajorClaim: true, recentSourceCount: 2, citesInline: false })).toBe('allow');
  });

  it('(3) bad-news after a Read -> ALLOW (recent source covers it)', () => {
    const text = 'kill switch armed, edge failed';
    expect(detectMajorClaim(text).matched).toBe(true);          // "edge" is a major-claim word
    expect(decideVerify({ hasMajorClaim: true, recentSourceCount: 1, citesInline: false })).toBe('allow');
  });

  it('(4) neutral message -> ALLOW', () => {
    const text = 'Booting up, one moment';
    expect(detectMajorClaim(text).matched).toBe(false);
    expect(decideVerify({ hasMajorClaim: false, recentSourceCount: 0, citesInline: false })).toBe('allow');
  });

  it('(5) error / missing db (unknown source count) -> ALLOW (fail-open)', () => {
    expect(decideVerify({ hasMajorClaim: true, recentSourceCount: -1, citesInline: false })).toBe('allow');
  });
});

// ---- bad-news exemption (never suppress incident reports) ----
describe('isBadNews exemption', () => {
  it('flags bad-news/incident messages so they always pass', () => {
    for (const t of ['kill switch armed, edge failed', 'broker down, incident',
                     'no real money on the band', 'reconcile shows a -$37 discrepancy', 'band killed OOS'])
      expect(isBadNews(t)).toBe(true);
  });
  it('does not flag a positive over-assertion as bad-news', () => {
    expect(isBadNews('band is profitable, fund it')).toBe(false);
    expect(isBadNews('the edge is proven, 75% win')).toBe(false);
  });
});

// ---- inline-citation allow path ----
describe('citesSourceInline', () => {
  it('allows a claim that cites a file path / verified-via / db ref', () => {
    expect(citesSourceInline('band fails OOS, verified via deliverables/band-5570.md')).toBe(true);
    expect(citesSourceInline('balance $4.18 confirmed via get_balance')).toBe(true);
    expect(citesSourceInline('reconciled per the settlements db')).toBe(true);
    // a major claim WITH an inline citation -> allow even with no recent source-query
    expect(decideVerify({ hasMajorClaim: true, recentSourceCount: 0, citesInline: true })).toBe('allow');
  });
  it('does not treat a bare assertion as cited', () => {
    expect(citesSourceInline('the band is a real edge, fund it')).toBe(false);
  });
});

// ---- detectMajorClaim coverage ----
describe('detectMajorClaim', () => {
  it('flags verdict words', () => {
    for (const t of ['it survives the funnel', 'this is the proven edge', 'WFE 0.29 mirage'])
      expect(detectMajorClaim(t).matched).toBe(true);
  });
  it('flags status words', () => {
    for (const t of ['deploy done', 'all tests passed', 'fix verified'])
      expect(detectMajorClaim(t).matched).toBe(true);
  });
  it('flags numbers-as-fact (%, $, z=, sigma, x-multiple)', () => {
    for (const t of ['win 75%', 'balance $4.18', 'z=2.04', '3.5x the 1-min'])
      expect(detectMajorClaim(t).matched).toBe(true);
  });
  it('does not flag plain chatter', () => {
    expect(detectMajorClaim('standing by for your go').matched).toBe(false);
    expect(detectMajorClaim('switching to the next task').matched).toBe(false);
  });
});

// ---- isSourceQuery (the PostToolUse recorder) ----
describe('isSourceQuery', () => {
  it('records every Read', () => {
    expect(isSourceQuery('Read', { file_path: '/x/y.md' }).match).toBe(true);
  });
  it('records data-reading Bash (sqlite3 / get_balance / cat / grep / curl / python-read)', () => {
    for (const cmd of [
      'sqlite3 state.db "SELECT 1"',
      'python3 -c "AlpacaClient().get_balance()"',
      'cat deliverables/x.md',
      'grep foo bar.py',
      'curl https://api.example.com',
      'python3 -c "import json; json.load(open(\'x.json\'))"',
    ]) expect(isSourceQuery('Bash', { command: cmd }).match).toBe(true);
  });
  it('does NOT record a non-query Bash (e.g. send-telegram)', () => {
    expect(isSourceQuery('Bash', { command: 'cortextos bus send-telegram 123 "hi"' }).match).toBe(false);
    expect(isSourceQuery('Bash', { command: 'echo done' }).match).toBe(false);
  });
});

// ---- send-detection helpers ----
describe('send-detection', () => {
  it('detects telegram/message sends', () => {
    expect(isTelegramSend('cortextos bus send-telegram 1 "x"')).toBe(true);
    expect(isTelegramSend('cortextos bus send-message jarvis normal "x"')).toBe(true);
    expect(isTelegramSend('ls -la')).toBe(false);
  });
  it('extracts the message text', () => {
    expect(extractMessageText('cortextos bus send-telegram 123 "band is profitable"')).toBe('band is profitable');
    expect(extractMessageText("cortextos bus send-message jarvis normal 'edge failed'")).toBe('edge failed');
  });
});
