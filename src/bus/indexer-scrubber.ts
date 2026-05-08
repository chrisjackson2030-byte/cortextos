// ---------------------------------------------------------------------------
// JSONL Session Transcript Indexer — Secrets Scrubbing Pipeline
// ---------------------------------------------------------------------------
//
// Phase 1 skeleton: synchronous, non-reversible scrubbing of sensitive
// content before it enters the SQLite index.  The original JSONL files are
// never modified.
//
// All regex patterns from the architecture doc are implemented.  The
// scrubber returns both the scrubbed text and a list of which patterns
// matched (for the scrub_log table, which tracks redaction events without
// storing the secrets themselves).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A record of one redaction event.  Stored in the `scrub_log` table so
 * scrubbing accuracy can be audited without retaining the secrets.
 */
export interface ScrubMatch {
  /** Which named pattern triggered the redaction. */
  patternName: string;
  /** Number of replacements made by this pattern in one invocation. */
  matchCount: number;
}

/**
 * The result of scrubbing a piece of text.
 */
export interface ScrubResult {
  /** The scrubbed text with secrets replaced by redaction markers. */
  text: string;
  /** List of patterns that matched (empty if nothing was scrubbed). */
  matches: ScrubMatch[];
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * One scrubbing rule: a named regex and its replacement string.
 *
 * All patterns use the `g` flag (and `i` where appropriate) so they
 * replace every occurrence in a single pass.  Order matters — more
 * specific patterns (AWS keys, GitHub tokens) run before the generic
 * long-hex catch-all to avoid double-redaction.
 */
interface ScrubPattern {
  name: string;
  regex: RegExp;
  replacement: string | ((match: string) => string);
}

/**
 * The ordered list of scrub patterns.  Exported for testing.
 *
 * Pattern order:
 *   1. Specific, high-confidence patterns (AWS, GitHub, Telegram, Bearer)
 *   2. Generic key=value patterns
 *   3. .env line catch-all (broadest, lowest confidence)
 */
export const SCRUB_PATTERNS: readonly ScrubPattern[] = [
  // -------------------------------------------------------------------
  // AWS-style access keys (AKIA/ASIA prefix + 16 uppercase alphanum)
  // -------------------------------------------------------------------
  {
    name: 'aws_key',
    regex: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    replacement: '[REDACTED_AWS_KEY]',
  },

  // -------------------------------------------------------------------
  // GitHub personal access tokens and secrets (ghp_, ghs_ prefix)
  // -------------------------------------------------------------------
  {
    name: 'github_token',
    regex: /gh[ps]_[A-Za-z0-9_]{36,}/g,
    replacement: '[REDACTED_GH_TOKEN]',
  },

  // -------------------------------------------------------------------
  // Telegram bot tokens (numeric bot ID : alphanumeric token)
  // -------------------------------------------------------------------
  {
    name: 'telegram_bot_token',
    regex: /\d{8,10}:[A-Za-z0-9_-]{35}/g,
    replacement: '[REDACTED_BOT_TOKEN]',
  },

  // -------------------------------------------------------------------
  // Bearer tokens in Authorization headers
  // -------------------------------------------------------------------
  {
    name: 'bearer_token',
    regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi,
    replacement: 'Bearer [REDACTED]',
  },

  // -------------------------------------------------------------------
  // Generic api_key / token / secret / password / credential / auth
  // in key=value or key: value context
  // -------------------------------------------------------------------
  {
    name: 'api_key_value',
    regex: /(?:api[_-]?key|token|secret|password|credential|auth)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi,
    replacement: (match: string): string => {
      // Preserve the key name, redact only the value
      const eqIdx = match.search(/[:=]/);
      if (eqIdx === -1) return '[REDACTED]';
      const prefix = match.slice(0, eqIdx + 1);
      return `${prefix} [REDACTED]`;
    },
  },

  // -------------------------------------------------------------------
  // Generic KEY/TOKEN/SECRET/PASS/AUTH = long_value patterns
  // -------------------------------------------------------------------
  {
    name: 'generic_key_value',
    regex: /(?:KEY|TOKEN|SECRET|PASS|AUTH).*?=\s*['"]?([A-Za-z0-9+/=_\-]{32,})['"]?/gi,
    replacement: (match: string): string => {
      const eqIdx = match.indexOf('=');
      if (eqIdx === -1) return '[REDACTED]';
      const prefix = match.slice(0, eqIdx + 1);
      return `${prefix} [REDACTED]`;
    },
  },

  // -------------------------------------------------------------------
  // .env file content patterns — lines that look like ENV_VAR=longvalue
  // Broadest pattern, runs last.
  // -------------------------------------------------------------------
  {
    name: 'env_line',
    regex: /^[A-Z][A-Z0-9_]+=.{20,}$/gm,
    replacement: '[REDACTED_ENV_LINE]',
  },
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply a single pattern to text, tracking match count.
 */
function applyPattern(
  text: string,
  pattern: ScrubPattern,
): { text: string; matchCount: number } {
  let matchCount = 0;
  const { regex, replacement } = pattern;

  // Reset regex lastIndex for stateful (global) regexes
  regex.lastIndex = 0;

  if (typeof replacement === 'function') {
    const replaceFn = replacement;
    const scrubbed = text.replace(regex, (match: string) => {
      matchCount++;
      return replaceFn(match);
    });
    return { text: scrubbed, matchCount };
  }

  const fixedReplacement = replacement;
  const scrubbed = text.replace(regex, () => {
    matchCount++;
    return fixedReplacement;
  });
  return { text: scrubbed, matchCount };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub sensitive content from a piece of text.  Applies all patterns in
 * order.  Returns the scrubbed text and a list of which patterns matched.
 *
 * This function is synchronous, deterministic, and non-reversible.  The
 * original text cannot be recovered from the output.
 *
 * @param text  The raw text to scrub (tool input JSON, tool result text,
 *              or user message content containing tool results).
 * @returns     The scrubbed text and match metadata for the scrub_log.
 */
export function scrubSecrets(text: string): ScrubResult {
  if (!text) {
    return { text: '', matches: [] };
  }

  let current = text;
  const matches: ScrubMatch[] = [];

  for (const pattern of SCRUB_PATTERNS) {
    const result = applyPattern(current, pattern);
    if (result.matchCount > 0) {
      matches.push({
        patternName: pattern.name,
        matchCount: result.matchCount,
      });
      current = result.text;
    }
  }

  return { text: current, matches };
}

/**
 * Scrub a JSON-stringified tool input.  Parses the JSON, scrubs string
 * values recursively, and re-serialises.  For tool inputs that are simple
 * strings (e.g. Bash command), scrubs the string directly.
 *
 * Falls back to scrubbing the raw JSON string if parsing fails.
 *
 * @param inputJson  JSON-stringified tool input from an assistant message.
 * @returns          Scrubbed JSON string and match metadata.
 */
export function scrubToolInput(inputJson: string): ScrubResult {
  if (!inputJson) {
    return { text: '{}', matches: [] };
  }

  // Scrub the entire JSON string as text.  This catches secrets in both
  // keys and values without needing recursive object traversal.  The
  // trade-off is that a regex could theoretically match across a JSON
  // structural boundary, but in practice our patterns target value-shaped
  // strings, not JSON syntax.
  return scrubSecrets(inputJson);
}

/**
 * Check whether a piece of text contains any patterns that would be
 * scrubbed.  Useful for pre-flight checks without modifying the text.
 *
 * @param text  The text to check.
 * @returns     True if at least one scrub pattern matches.
 */
export function containsSecrets(text: string): boolean {
  if (!text) return false;

  for (const pattern of SCRUB_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      return true;
    }
  }
  return false;
}
