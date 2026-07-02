/**
 * WS7 fast-path auto-ack unit tests.
 *
 * DISABLED behavior contract (B 2026-06-21): maybeAutoAck() is a permanent
 * no-op. The pre-emptive "received, on it" ack became noise because the agent
 * replies for real within seconds. These tests pin the no-op contract:
 *   1. NEVER sends a Telegram message, busy or idle
 *   2. ALWAYS returns false
 *   3. Call site remains safe (no throw), including rapid repeated calls
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    injectMessageDetailed: vi.fn().mockReturnValue({ ok: true }),
    isBusy: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue(null),
    getAgentDir: vi.fn().mockReturnValue('/tmp'),
    getConfig: vi.fn().mockReturnValue({}),
  } as any;
}

function createMockTelegramApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

describe('FastChecker.maybeAutoAck (WS7 fast-path auto-ack)', () => {
  let testDir: string;
  let paths: BusPaths;
  let checker: FastChecker;
  let api: ReturnType<typeof createMockTelegramApi>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-autoack-test-'));
    paths = createTestPaths(testDir);
    const agent = createMockAgent();
    checker = new FastChecker(agent, paths, '/tmp', { log: () => {} });
    api = createMockTelegramApi();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('does NOT send ack and returns false when agent is busy (disabled per B 2026-06-21)', () => {
    const sent = checker.maybeAutoAck(true, api, '12345');
    expect(sent).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send ack and returns false when agent is idle', () => {
    const sent = checker.maybeAutoAck(false, api, '12345');
    expect(sent).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('never sends an ack across rapid repeated busy calls', () => {
    for (let i = 0; i < 5; i++) {
      expect(checker.maybeAutoAck(true, api, '12345')).toBe(false);
    }
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('never sends an ack even with a 0ms dedup window', () => {
    checker.maybeAutoAck(true, api, '12345', 0);
    checker.maybeAutoAck(true, api, '12345', 0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('mixed busy/idle call sequence sends nothing', () => {
    checker.maybeAutoAck(true, api, '12345');
    checker.maybeAutoAck(false, api, '12345');
    checker.maybeAutoAck(true, api, '12345');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('call site remains safe: no throw even if sendMessage would reject', async () => {
    api.sendMessage.mockRejectedValue(new Error('network error'));
    expect(() => checker.maybeAutoAck(true, api, '12345')).not.toThrow();
    // allow any (unexpected) rejected promise to settle without crashing
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
