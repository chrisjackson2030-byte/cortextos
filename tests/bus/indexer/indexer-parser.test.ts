import { describe, it, expect } from 'vitest';
import {
  parseLine,
  extractSessionMetadata,
  isIndexableLine,
  countLines,
} from '../../../src/bus/indexer-parser.js';

// ---------------------------------------------------------------------------
// Helpers — build synthetic JSONL line strings
// ---------------------------------------------------------------------------

function userLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'user-001',
    parentUuid: null,
    timestamp: '2026-05-08T01:00:00.000Z',
    sessionId: 'sess-001',
    gitBranch: 'main',
    cwd: '/home/user',
    version: '2.1.119',
    message: { role: 'user', content: 'Hello, world!' },
    ...overrides,
  });
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'asst-001',
    parentUuid: 'user-001',
    timestamp: '2026-05-08T01:00:02.000Z',
    sessionId: 'sess-001',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hi there!' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// parseLine — user messages
// ---------------------------------------------------------------------------

describe('parseLine — user messages', () => {
  it('parses a plain string user message', () => {
    const line = userLine();
    const result = parseLine(line, 0, 0);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('user');
    expect(result!.contentText).toBe('Hello, world!');
    expect(result!.thinkingBlocks).toHaveLength(0);
    expect(result!.hasToolUse).toBe(false);
    expect(result!.toolResults).toHaveLength(0);
    expect(result!.turnIndex).toBe(0);
    expect(result!.lineOffset).toBe(0);
  });

  it('parses a user message with tool_result content array', () => {
    const line = userLine({
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu-001', content: 'Build succeeded.', is_error: false },
        ],
      },
    });
    const result = parseLine(line, 1, 512);
    expect(result).not.toBeNull();
    expect(result!.contentText).toBeNull(); // no text blocks
    expect(result!.toolResults).toHaveLength(1);
    expect(result!.toolResults[0].tool_use_id).toBe('toolu-001');
    expect(result!.toolResults[0].content_text).toBe('Build succeeded.');
    expect(result!.toolResults[0].is_error).toBe(false);
    expect(result!.lineOffset).toBe(512);
  });

  it('extracts text from mixed text + tool_result content array', () => {
    const line = userLine({
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Result below:' },
          { type: 'tool_result', tool_use_id: 'toolu-002', content: 'output data' },
        ],
      },
    });
    const result = parseLine(line, 2, 0);
    expect(result).not.toBeNull();
    expect(result!.contentText).toBe('Result below:');
    expect(result!.toolResults).toHaveLength(1);
  });

  it('propagates sessionId, gitBranch, cwd from user line', () => {
    const result = parseLine(userLine(), 0, 0);
    expect(result!.sessionId).toBe('sess-001');
    expect(result!.gitBranch).toBe('main');
    expect(result!.cwd).toBe('/home/user');
  });
});

// ---------------------------------------------------------------------------
// parseLine — assistant messages
// ---------------------------------------------------------------------------

describe('parseLine — assistant messages', () => {
  it('parses a basic assistant text message', () => {
    const result = parseLine(assistantLine(), 1, 200);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('assistant');
    expect(result!.contentText).toBe('Hi there!');
    expect(result!.thinkingBlocks).toHaveLength(0);
    expect(result!.hasToolUse).toBe(false);
    expect(result!.toolCalls).toHaveLength(0);
  });

  it('extracts thinking block as ExtractedThinkingBlock with sequence_in_turn', () => {
    const line = assistantLine({
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'Internal reasoning here.', signature: 'sig-001' },
          { type: 'text', text: 'Final answer.' },
        ],
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const result = parseLine(line, 2, 0);
    expect(result).not.toBeNull();
    expect(result!.thinkingBlocks).toHaveLength(1);
    expect(result!.thinkingBlocks[0].sequence_in_turn).toBe(0);
    expect(result!.thinkingBlocks[0].content).toBe('Internal reasoning here.');
    expect(result!.contentText).toBe('Final answer.');
  });

  it('emits multiple thinking blocks as separate ExtractedThinkingBlock entries', () => {
    const line = assistantLine({
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'Block one.', signature: 'sig-a' },
          { type: 'thinking', thinking: 'Block two.', signature: 'sig-b' },
          { type: 'text', text: 'Done.' },
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const result = parseLine(line, 0, 0);
    expect(result!.thinkingBlocks).toHaveLength(2);
    expect(result!.thinkingBlocks[0]).toEqual({ sequence_in_turn: 0, content: 'Block one.' });
    expect(result!.thinkingBlocks[1]).toEqual({ sequence_in_turn: 1, content: 'Block two.' });
  });

  it('extracts tool_use blocks and sets hasToolUse', () => {
    const line = assistantLine({
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Running command.' },
          { type: 'tool_use', id: 'toolu-abc', name: 'Bash', input: { command: 'ls -la' } },
        ],
        usage: { input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const result = parseLine(line, 0, 0);
    expect(result!.hasToolUse).toBe(true);
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0].tool_name).toBe('Bash');
    expect(result!.toolCalls[0].tool_use_id).toBe('toolu-abc');
    expect(JSON.parse(result!.toolCalls[0].input_json)).toEqual({ command: 'ls -la' });
  });

  it('extracts token usage from assistant message', () => {
    const result = parseLine(assistantLine(), 0, 0);
    expect(result!.tokenUsage).not.toBeNull();
    expect(result!.tokenUsage!.input_tokens).toBe(10);
    expect(result!.tokenUsage!.output_tokens).toBe(5);
    expect(result!.tokenUsage!.cache_read_input_tokens).toBe(100);
    expect(result!.tokenUsage!.cache_creation_input_tokens).toBe(0);
  });

  it('extracts model and stopReason', () => {
    const result = parseLine(assistantLine(), 0, 0);
    expect(result!.model).toBe('claude-sonnet-4-6');
    expect(result!.stopReason).toBe('end_turn');
  });
});

// ---------------------------------------------------------------------------
// parseLine — non-indexable line types
// ---------------------------------------------------------------------------

describe('parseLine — non-indexable lines return null', () => {
  const skipTypes = ['system', 'queue-operation', 'file-history-snapshot', 'attachment', 'permission-mode', 'last-prompt'];

  for (const lineType of skipTypes) {
    it(`returns null for type="${lineType}"`, () => {
      const line = JSON.stringify({ type: lineType, uuid: 'x', timestamp: '2026-01-01T00:00:00Z', sessionId: 'sess-x' });
      expect(parseLine(line, 0, 0)).toBeNull();
    });
  }

  it('returns null for malformed JSON', () => {
    expect(parseLine('not-json{{{', 0, 0)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseLine('', 0, 0)).toBeNull();
  });

  it('returns null for whitespace-only line', () => {
    expect(parseLine('   ', 0, 0)).toBeNull();
  });

  it('returns null for line missing uuid', () => {
    const line = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } });
    expect(parseLine(line, 0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractSessionMetadata
// ---------------------------------------------------------------------------

describe('extractSessionMetadata', () => {
  it('extracts metadata from a user line', () => {
    const meta = extractSessionMetadata(userLine());
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe('sess-001');
    expect(meta!.gitBranch).toBe('main');
    expect(meta!.cwd).toBe('/home/user');
  });

  it('extracts model from an assistant line', () => {
    const meta = extractSessionMetadata(assistantLine());
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe('claude-sonnet-4-6');
  });

  it('returns null for line without sessionId', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'hi' } });
    expect(extractSessionMetadata(line)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isIndexableLine
// ---------------------------------------------------------------------------

describe('isIndexableLine', () => {
  it('returns true for user lines', () => {
    expect(isIndexableLine(userLine())).toBe(true);
  });

  it('returns true for assistant lines', () => {
    expect(isIndexableLine(assistantLine())).toBe(true);
  });

  it('returns false for system lines', () => {
    expect(isIndexableLine('{"type":"system","uuid":"x"}')).toBe(false);
  });

  it('handles whitespace in type field', () => {
    expect(isIndexableLine('{"type": "user","uuid":"x"}')).toBe(true);
    expect(isIndexableLine('{"type": "assistant","uuid":"x"}')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------

describe('countLines', () => {
  it('counts lines correctly', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\nb\nc\n')).toBe(3);
    expect(countLines('single')).toBe(1);
    expect(countLines('')).toBe(0);
  });
});
