/**
 * WS7 fast-path auto-ack unit tests.
 *
 * Verifies FastChecker.maybeAutoAck() behavior:
 *   1. Fires when isBusy=true
 *   2. Does NOT fire when isBusy=false
 *   3. Dedups: only one ack per busy-window (30s default)
 *   4. Sends ack again after the dedup window expires
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

  it('sends ack and returns true when agent is busy', () => {
    const sent = checker.maybeAutoAck(true, api, '12345');
    expect(sent).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith('12345', 'received, on it');
  });

  it('does NOT send ack and returns false when agent is idle', () => {
    const sent = checker.maybeAutoAck(false, api, '12345');
    expect(sent).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('dedups: second call within window does NOT send another ack', () => {
    const first = checker.maybeAutoAck(true, api, '12345');
    const second = checker.maybeAutoAck(true, api, '12345');
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it('dedups multiple rapid calls to a single ack', () => {
    for (let i = 0; i < 5; i++) {
      checker.maybeAutoAck(true, api, '12345');
    }
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it('sends a fresh ack after the dedup window expires', () => {
    // Use a 0ms window so the second call fires immediately
    checker.maybeAutoAck(true, api, '12345', 0);
    checker.maybeAutoAck(true, api, '12345', 0);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('idle call between busy calls does not reset the dedup window', () => {
    checker.maybeAutoAck(true, api, '12345');   // fires
    checker.maybeAutoAck(false, api, '12345');  // idle — skipped
    checker.maybeAutoAck(true, api, '12345');   // still within window — skipped
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it('swallows sendMessage rejections without throwing', async () => {
    api.sendMessage.mockRejectedValue(new Error('network error'));
    expect(() => checker.maybeAutoAck(true, api, '12345')).not.toThrow();
    // allow the rejected promise to settle without crashing
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
