import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-forward-route-'));
process.env.FORWARD_TRACKING_ROOT = rootTmp;

const trackingDir = path.join(rootTmp, 'forward_tracking');
const paperDir = path.join(trackingDir, 'cluster_paper');

beforeAll(() => {
  fs.mkdirSync(paperDir, { recursive: true });

  fs.writeFileSync(
    path.join(trackingDir, 'shib_kraken_probe_status.json'),
    JSON.stringify(
      {
        mode: 'live',
        live_equity_usd: 104.25,
        starting_equity_usd: 100,
        cumulative_realized_pnl: 4.25,
        budget_usd: 100,
        kill_line_usd: -40,
        halted: false,
        position: { side: 'long', qty: 1200000 },
        last_event: {
          kind: 'fill',
          action: 'buy',
          ts: 1780675200,
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(paperDir, 'alpha.jsonl'),
    [
      JSON.stringify({
        kind: 'paper_bar',
        config_id: 'alpha',
        signal: 'short',
        action: 'enter',
        stats: { n: 0, win_pct: 0, net_r: 0 },
        trade: null,
        open_position: { direction: 'short' },
      }),
      JSON.stringify({
        kind: 'paper_bar',
        config_id: 'alpha',
        signal: 'flat',
        action: 'exit',
        stats: { n: 1, win_pct: 100, net_r: 1.9 },
        trade: { realized_r: 1.9 },
        open_position: null,
      }),
    ].join('\n') + '\n',
  );

  fs.writeFileSync(
    path.join(paperDir, 'beta.jsonl'),
    [
      JSON.stringify({
        kind: 'paper_bar',
        config_id: 'beta',
        signal: 'long',
        action: 'enter',
        stats: { n: 0, win_pct: 0, net_r: 0 },
        trade: null,
        open_position: { direction: 'long' },
      }),
    ].join('\n') + '\n',
  );
});

afterAll(() => {
  try {
    fs.rmSync(rootTmp, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors in tests
  }
});

let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  const mod = await import('../route');
  GET = mod.GET;
});

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/live-forward');
}

describe('GET /api/live-forward', () => {
  it('returns the live probe and paper cluster summaries', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.available).toBe(true);

    expect(data.realMoney.mode).toBe('live');
    expect(data.realMoney.live_equity_usd).toBe(104.25);
    expect(data.realMoney.last_action).toBe('buy');
    expect(data.realMoney.position_label).toBe('long');

    expect(data.paperCluster).toHaveLength(2);
    expect(data.paperCluster[0]).toMatchObject({
      config_id: 'alpha',
      paper_trades: 1,
      position: 'flat',
      last_signal: 'flat',
      win_pct: 100,
      net_r: 1.9,
    });
    expect(data.paperCluster[1]).toMatchObject({
      config_id: 'beta',
      paper_trades: 0,
      position: 'long',
      last_signal: 'long',
      win_pct: null,
      net_r: null,
    });
  });
});
