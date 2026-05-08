// ---------------------------------------------------------------------------
// JSONL Session Transcript Indexer — Line Parser + Content Extraction
// ---------------------------------------------------------------------------
//
// Phase 1 skeleton: parse individual JSONL lines from Claude Code session
// transcripts.  Extracts user messages, assistant responses (text + thinking
// + tool_use), tool results, token usage, and session metadata.
//
// Synchronous API — no async, no streams.  The caller (indexer.ts, Phase 2)
// is responsible for line-by-line iteration and byte-offset tracking.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types — content blocks within a message
// ---------------------------------------------------------------------------

/** A single text block in an assistant or user message. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** A thinking block in an assistant message (Decision #1: indexed). */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** A tool_use block in an assistant message. */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool_result block in a user message (returned after tool execution). */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Union of all content block types we extract. */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Types — token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// ---------------------------------------------------------------------------
// Types — parsed line output
// ---------------------------------------------------------------------------

/** Line types that produce indexable content. */
export type IndexableLineType = 'user' | 'assistant';

/** All known JSONL line types (including non-indexable). */
export type JsonlLineType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'queue-operation'
  | 'file-history-snapshot'
  | 'attachment'
  | 'permission-mode'
  | 'last-prompt';

/**
 * A tool call extracted from an assistant message.  Stored in the
 * `tool_calls` table by the indexer.
 */
export interface ExtractedToolCall {
  tool_use_id: string;
  tool_name: string;
  input_json: string; // JSON-stringified tool input (will be scrubbed)
}

/**
 * A tool result extracted from a user message.  Stored in the
 * `tool_results` table by the indexer.
 */
export interface ExtractedToolResult {
  tool_use_id: string;
  content_text: string; // will be scrubbed
  is_error: boolean;
}

/**
 * The fully parsed representation of one indexable JSONL line.  Returned
 * by `parseLine` for lines that should be inserted into the database.
 *
 * Non-indexable lines (system, attachment, permission-mode, etc.) cause
 * `parseLine` to return `null`.
 */
export interface ParsedLine {
  /** Message UUID from the JSONL line. */
  uuid: string;
  /** Parent message UUID for conversation threading. */
  parentUuid: string | null;
  /** 0-based position within the session. */
  turnIndex: number;
  /** 'user' or 'assistant'. */
  role: IndexableLineType;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Concatenated plain text content (searchable). */
  contentText: string | null;
  /** Concatenated thinking block text (Decision #1). */
  thinkingText: string | null;
  /** Whether any thinking blocks were present. */
  hasThinking: boolean;
  /** Whether any tool_use blocks were present. */
  hasToolUse: boolean;
  /** Stop reason from the API response (assistant lines only). */
  stopReason: string | null;
  /** Token usage (assistant lines only). */
  tokenUsage: TokenUsage | null;
  /** Model identifier (assistant lines only). */
  model: string | null;
  /** Byte offset of this line in the JSONL file (for random access). */
  lineOffset: number;
  /** Extracted tool calls (assistant lines). */
  toolCalls: ExtractedToolCall[];
  /** Extracted tool results (user lines with tool_result content). */
  toolResults: ExtractedToolResult[];
  /** Session ID from the line (for cross-check against filename). */
  sessionId: string | null;
  /** Git branch at time of message. */
  gitBranch: string | null;
  /** Working directory at time of message. */
  cwd: string | null;
}

/**
 * Session-level metadata extracted from the first few lines of a JSONL
 * file.  Used to populate the `sessions` table.
 */
export interface SessionMetadata {
  sessionId: string;
  model: string | null;
  gitBranch: string | null;
  cwd: string | null;
  startedAt: string | null;
  version: string | null;
}

// ---------------------------------------------------------------------------
// Raw JSONL line shape (internal — loose typing for JSON.parse output)
// ---------------------------------------------------------------------------

interface RawJsonlLine {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  // System line fields
  subtype?: string;
  stopReason?: string;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Line types that should be skipped entirely (no indexable content). */
const SKIP_TYPES = new Set<string>([
  'queue-operation',
  'file-history-snapshot',
  'attachment',
  'permission-mode',
  'last-prompt',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line and extract indexable content.
 *
 * Returns `null` for lines that should not be indexed (non-indexable types,
 * malformed JSON, or lines missing required fields).
 *
 * @param rawLine    The raw text of one line from the JSONL file.
 * @param turnIndex  The 0-based line index within the session.
 * @param byteOffset The byte offset of this line in the JSONL file.
 * @returns          A ParsedLine if the line is indexable, null otherwise.
 */
export function parseLine(
  rawLine: string,
  turnIndex: number,
  byteOffset: number,
): ParsedLine | null {
  // Fast-path: empty lines
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  let parsed: RawJsonlLine;
  try {
    parsed = JSON.parse(trimmed) as RawJsonlLine;
  } catch {
    // Malformed JSON — skip
    return null;
  }

  const lineType = parsed.type;
  if (!lineType) return null;

  // Skip non-indexable types
  if (SKIP_TYPES.has(lineType)) return null;

  // System lines: we extract metadata but don't create a full turn
  // (they lack user/assistant content).  Return null — the caller can
  // optionally use `parseSystemLine` for metadata extraction.
  if (lineType === 'system') return null;

  // Only user and assistant lines produce indexed turns
  if (lineType !== 'user' && lineType !== 'assistant') return null;

  const uuid = parsed.uuid;
  if (!uuid) return null;

  const timestamp = parsed.timestamp;
  if (!timestamp) return null;

  const role = lineType as IndexableLineType;
  const message = parsed.message;

  let contentText: string | null = null;
  let thinkingText: string | null = null;
  let hasThinking = false;
  let hasToolUse = false;
  let stopReason: string | null = null;
  let tokenUsage: TokenUsage | null = null;
  let model: string | null = null;
  const toolCalls: ExtractedToolCall[] = [];
  const toolResults: ExtractedToolResult[] = [];

  if (role === 'user') {
    if (message) {
      const content = message.content;
      if (typeof content === 'string') {
        contentText = content;
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            toolResults.push({
              tool_use_id: block.tool_use_id || '',
              content_text: typeof block.content === 'string' ? block.content : '',
              is_error: block.is_error === true,
            });
          }
        }
        if (textParts.length > 0) {
          contentText = textParts.join('\n');
        }
      }
    }
  } else if (role === 'assistant') {
    if (message) {
      model = message.model || null;
      stopReason = message.stop_reason || null;

      // Token usage
      if (message.usage) {
        tokenUsage = {
          input_tokens: message.usage.input_tokens || 0,
          output_tokens: message.usage.output_tokens || 0,
          cache_read_input_tokens: message.usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens || 0,
        };
      }

      // Content blocks
      const content = message.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking) {
            hasThinking = true;
            thinkingParts.push(block.thinking);
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            toolCalls.push({
              tool_use_id: block.id || '',
              tool_name: block.name || '',
              input_json: block.input ? JSON.stringify(block.input) : '{}',
            });
          }
        }

        if (textParts.length > 0) {
          contentText = textParts.join('\n');
        }
        if (thinkingParts.length > 0) {
          thinkingText = thinkingParts.join('\n');
        }
      }
    }
  }

  return {
    uuid,
    parentUuid: parsed.parentUuid || null,
    turnIndex,
    role,
    timestamp,
    contentText,
    thinkingText,
    hasThinking,
    hasToolUse,
    stopReason,
    tokenUsage,
    model,
    lineOffset: byteOffset,
    toolCalls,
    toolResults,
    sessionId: parsed.sessionId || null,
    gitBranch: parsed.gitBranch || null,
    cwd: parsed.cwd || null,
  };
}

/**
 * Extract session-level metadata from a parsed JSONL line.  Intended to be
 * called on the first few lines of a session file to populate the `sessions`
 * table.
 *
 * Returns partial metadata — the caller should merge results from multiple
 * lines (e.g. the first user line provides cwd/branch, the first assistant
 * line provides model).
 */
export function extractSessionMetadata(
  rawLine: string,
): SessionMetadata | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  let parsed: RawJsonlLine;
  try {
    parsed = JSON.parse(trimmed) as RawJsonlLine;
  } catch {
    return null;
  }

  if (!parsed.sessionId) return null;

  return {
    sessionId: parsed.sessionId,
    model: parsed.message?.model || null,
    gitBranch: parsed.gitBranch || null,
    cwd: parsed.cwd || null,
    startedAt: parsed.timestamp || null,
    version: parsed.version || null,
  };
}

/**
 * Check whether a raw JSONL line is of an indexable type without fully
 * parsing it.  Useful for fast filtering in streaming scenarios.
 *
 * Performs a cheap string search before JSON.parse to avoid parsing
 * non-indexable lines entirely.
 */
export function isIndexableLine(rawLine: string): boolean {
  // Quick string checks — these are cheaper than JSON.parse.
  // All user/assistant lines contain "type":"user" or "type":"assistant".
  if (rawLine.includes('"type":"user"') || rawLine.includes('"type":"assistant"')) {
    return true;
  }
  // Handle whitespace variations: "type": "user", "type" : "assistant"
  if (rawLine.includes('"type": "user"') || rawLine.includes('"type": "assistant"')) {
    return true;
  }
  return false;
}

/**
 * Count the total number of lines in a JSONL string.  Handles trailing
 * newlines correctly (does not count an empty final line).
 */
export function countLines(content: string): number {
  if (!content) return 0;
  let count = 0;
  let i = 0;
  while (i < content.length) {
    const nl = content.indexOf('\n', i);
    if (nl === -1) {
      // Last line without trailing newline
      if (i < content.length) count++;
      break;
    }
    count++;
    i = nl + 1;
  }
  return count;
}
