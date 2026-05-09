import { describe, it, expect } from 'vitest';
import { scrubSecrets, scrubToolInput, containsSecrets, SCRUB_PATTERNS } from '../../../src/bus/indexer-scrubber.js';

// ---------------------------------------------------------------------------
// scrubSecrets — pattern coverage
// ---------------------------------------------------------------------------

describe('scrubSecrets — individual patterns', () => {
  it('redacts AWS-style access keys (AKIA prefix)', () => {
    const text = 'key=AKIAIOSFODNN7EXAMPLE123';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_AWS_KEY]');
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE123');
    expect(result.matches.some(m => m.patternName === 'aws_key')).toBe(true);
  });

  it('redacts AWS-style access keys (ASIA prefix)', () => {
    const text = 'ASIAIOSFODNN7EXAMPLE1234';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_AWS_KEY]');
    expect(result.matches.some(m => m.patternName === 'aws_key')).toBe(true);
  });

  it('redacts GitHub personal access tokens (ghp_ prefix)', () => {
    // regex requires {36,} chars after the prefix — use 36 chars
    const text = 'token: ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_GH_TOKEN]');
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.matches.some(m => m.patternName === 'github_token')).toBe(true);
  });

  it('redacts GitHub secret tokens (ghs_ prefix)', () => {
    const text = 'ghs_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_GH_TOKEN]');
  });

  it('redacts Telegram bot tokens', () => {
    // regex: \d{8,10}:[A-Za-z0-9_-]{35} — use bare token (no KEY= prefix to
    // avoid env_line cascading over the [REDACTED_BOT_TOKEN] replacement)
    const text = '1234567890:ABCDefghijklmnopqrstuvwxyz_12345678';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_BOT_TOKEN]');
    expect(result.text).not.toContain('ABCDefghijklmnopqrstuvwxyz_12345678');
    expect(result.matches.some(m => m.patternName === 'telegram_bot_token')).toBe(true);
  });

  it('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456';
    const result = scrubSecrets(text);
    expect(result.text).toContain('Bearer [REDACTED]');
    expect(result.matches.some(m => m.patternName === 'bearer_token')).toBe(true);
  });

  it('redacts api_key=value patterns (preserves key name)', () => {
    const text = 'api_key=supersecretapikey12345678901';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED]');
    expect(result.text).not.toContain('supersecretapikey12345678901');
    expect(result.matches.some(m => m.patternName === 'api_key_value')).toBe(true);
  });

  it('redacts token: value patterns', () => {
    const text = 'token: verylongsecrettokenvalue12345678';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED]');
    expect(result.matches.some(m => m.patternName === 'api_key_value')).toBe(true);
  });

  it('redacts .env file lines (KEY=longvalue)', () => {
    // Key must not contain generic_key_value keywords (KEY/TOKEN/SECRET/PASS/AUTH)
    // so env_line is the first and only pattern to fire
    const text = 'DATABASE_URL=averylongvaluethatshouldberedacted1234567890';
    const result = scrubSecrets(text);
    expect(result.text).toContain('[REDACTED_ENV_LINE]');
    expect(result.matches.some(m => m.patternName === 'env_line')).toBe(true);
  });

  it('applies patterns in order — specific before generic', () => {
    // AWS key should be caught by aws_key before env_line
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE12';
    const result = scrubSecrets(text);
    const patternNames = result.matches.map(m => m.patternName);
    // aws_key pattern index < env_line pattern index
    const awsIdx = SCRUB_PATTERNS.findIndex(p => p.name === 'aws_key');
    const envIdx = SCRUB_PATTERNS.findIndex(p => p.name === 'env_line');
    expect(awsIdx).toBeLessThan(envIdx);
    expect(patternNames).toContain('aws_key');
  });
});

// ---------------------------------------------------------------------------
// scrubSecrets — clean text
// ---------------------------------------------------------------------------

describe('scrubSecrets — clean text', () => {
  it('returns clean text unchanged with empty matches', () => {
    const text = 'The build completed in 4.2 seconds.';
    const result = scrubSecrets(text);
    expect(result.text).toBe(text);
    expect(result.matches).toHaveLength(0);
  });

  it('handles empty string', () => {
    const result = scrubSecrets('');
    expect(result.text).toBe('');
    expect(result.matches).toHaveLength(0);
  });

  it('handles text with short values (below threshold)', () => {
    // Values shorter than pattern thresholds should not be redacted
    const text = 'token: short';
    const result = scrubSecrets(text);
    expect(result.text).toBe(text);
    expect(result.matches).toHaveLength(0);
  });

  it('tracks matchCount per pattern', () => {
    // Two AWS keys in one string
    const text = 'key1=AKIAIOSFODNN7EXAMPLE123 key2=AKIAIOSFODNN7EXAMPLE456';
    const result = scrubSecrets(text);
    const awsMatch = result.matches.find(m => m.patternName === 'aws_key');
    expect(awsMatch).toBeDefined();
    expect(awsMatch!.matchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// scrubToolInput
// ---------------------------------------------------------------------------

describe('scrubToolInput', () => {
  it('scrubs secrets in JSON-stringified tool input', () => {
    const inputJson = JSON.stringify({ command: 'echo AKIAIOSFODNN7EXAMPLE1234' });
    const result = scrubToolInput(inputJson);
    expect(result.text).toContain('[REDACTED_AWS_KEY]');
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE1234');
  });

  it('returns empty object for empty input', () => {
    const result = scrubToolInput('');
    expect(result.text).toBe('{}');
    expect(result.matches).toHaveLength(0);
  });

  it('passes clean JSON through unchanged', () => {
    const inputJson = JSON.stringify({ command: 'ls -la', path: '/home/user' });
    const result = scrubToolInput(inputJson);
    expect(result.text).toBe(inputJson);
    expect(result.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// containsSecrets
// ---------------------------------------------------------------------------

describe('containsSecrets', () => {
  it('returns true when text contains a secret pattern', () => {
    expect(containsSecrets('AKIAIOSFODNN7EXAMPLE1234')).toBe(true);
    // github_token regex requires {36,} chars after prefix
    expect(containsSecrets('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
  });

  it('returns false for clean text', () => {
    expect(containsSecrets('No secrets here.')).toBe(false);
    expect(containsSecrets('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pattern coverage check — all 7 patterns tested
// ---------------------------------------------------------------------------

describe('SCRUB_PATTERNS coverage', () => {
  it('exports exactly 7 patterns', () => {
    expect(SCRUB_PATTERNS).toHaveLength(7);
  });

  const expectedPatterns = [
    'aws_key',
    'github_token',
    'telegram_bot_token',
    'bearer_token',
    'api_key_value',
    'generic_key_value',
    'env_line',
  ];

  for (const name of expectedPatterns) {
    it(`includes pattern: ${name}`, () => {
      expect(SCRUB_PATTERNS.some(p => p.name === name)).toBe(true);
    });
  }
});
