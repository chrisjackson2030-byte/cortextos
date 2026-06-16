import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });
});

// WS6.5 item 3: transient poll errors must back off (capped exponential) and
// be log-deduped so a sustained network outage cannot flood daemon.err.log
// (root cause of the 95k+ "fetch failed" lines).
describe('TelegramPoller — transient-error backoff + log dedup (WS6.5 item 3)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-backoff-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('caps retry rate via backoff and logs an identical error only once', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const getUpdates = vi.fn(async () => {
      throw new Error('Telegram API request failed: TypeError: fetch failed');
    });
    const api = { getUpdates } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 1000);

    // Fire-and-forget the loop, then run 5 minutes of virtual time.
    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    poller.stop();
    // Let the final (up to 30s) backoff sleep resolve so the loop exits.
    await vi.advanceTimersByTimeAsync(35_000);

    // Backoff: without it, a 1s interval would attempt ~300 polls in 5 min.
    // With the capped exponential backoff it is an order of magnitude fewer.
    expect(getUpdates.mock.calls.length).toBeLessThan(50);

    // Dedup: the identical "fetch failed" error is logged exactly once
    // (first occurrence), not once per attempt.
    const firstOccurrenceLogs = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('Poll error:'),
    ).length;
    expect(firstOccurrenceLogs).toBe(1);

    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('logs recovery and resets after a successful poll following failures', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let attempts = 0;
    const getUpdates = vi.fn(async (_offset: number) => {
      attempts++;
      if (attempts <= 2) throw new Error('Telegram API request failed: TypeError: fetch failed');
      return { result: [] }; // recovers on the 3rd attempt
    });
    const api = { getUpdates } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 1000);

    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    poller.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    const recovered = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('Recovered after'),
    ).length;
    expect(recovered).toBe(1);

    errSpy.mockRestore();
    vi.useRealTimers();
  });
});
