import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const ROOT =
  process.env.FORWARD_TRACKING_ROOT ??
  path.join(process.env.HOME ?? '/Users/chrisjackson', 'cortextos-data/crypto-engine');
const TRACKING_DIR = path.join(ROOT, 'forward_tracking');
const SHIB_PROBE = path.join(TRACKING_DIR, 'shib_kraken_probe_status.json');
const PAPER_CLUSTER_DIR = path.join(TRACKING_DIR, 'cluster_paper');
const PROMISING_PAPER_DIR = path.join(TRACKING_DIR, 'promising_paper');
const PROMISING_REGISTRY = path.join(PROMISING_PAPER_DIR, 'registry.json');

type JsonRecord = Record<string, any>;

function readJson(filePath: string): JsonRecord | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonLines(filePath: string): JsonRecord[] {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function positionLabel(position: any): string {
  if (!position) return 'flat';
  return String(position.direction ?? position.side ?? position.position ?? 'open').toLowerCase();
}

function lastActionLabel(event: any): string {
  if (!event) return 'none';
  return String(event.action ?? event.kind ?? 'unknown').toLowerCase();
}

function summarizePaperConfig(filePath: string) {
  const events = readJsonLines(filePath);
  const last = events.at(-1) ?? null;
  const stats = last?.stats ?? {};
  const tradeCount = events.filter((event) => event?.trade).length;
  const configId =
    last?.config_id ??
    path.basename(filePath, path.extname(filePath));
  const trades = Number(stats.n ?? tradeCount ?? 0);

  return {
    config_id: configId,
    paper_trades: trades,
    position: positionLabel(last?.open_position),
    last_signal: last?.signal ?? 'unknown',
    last_action: last?.action ?? 'unknown',
    win_pct: trades > 0 ? Number(stats.win_pct ?? 0) : null,
    net_r: trades > 0 ? Number(stats.net_r ?? 0) : null,
    updated_utc: last?.recorded_utc ?? null,
  };
}

// Promising/confirmed LEADS being forward-paper-tested (the coverage B asked to see, 2026-06-07).
// Merges the registry (idea/family/verdict/registered) with each lead's live paper summary.
function readPromisingLeads() {
  const registry = readJson(PROMISING_REGISTRY);
  if (!registry) return [];
  return Object.values(registry).map((entry: any) => {
    const params = entry?.params ?? {};
    const logPath = path.join(PROMISING_PAPER_DIR, `${entry.config_id}.jsonl`);
    const summary = fs.existsSync(logPath)
      ? summarizePaperConfig(logPath)
      : { paper_trades: 0, position: 'flat', win_pct: null, net_r: null, updated_utc: null };
    const registeredAt = entry.registered_at_utc ?? null;
    const daysLive = registeredAt
      ? Math.max(0, (Date.now() - new Date(registeredAt).getTime()) / 86400000)
      : null;
    return {
      config_id: entry.config_id,
      idea: entry.idea ?? entry.config_id,
      symbol: params.asset ?? params.symbol ?? '—',
      family: params.family ?? '—',
      timeframe: params.timeframe ?? '—',
      verdict: entry.funnel_verdict ?? '—',
      registered_utc: registeredAt,
      days_live: daysLive != null ? Number(daysLive.toFixed(1)) : null,
      paper_trades: summary.paper_trades,
      position: summary.position,
      win_pct: summary.win_pct,
      net_r: summary.net_r,
      status: summary.paper_trades > 0 ? 'trading' : 'warming up',
    };
  });
}

export async function GET(_req: NextRequest) {
  const realMoney = readJson(SHIB_PROBE);
  const paperFiles = fs.existsSync(PAPER_CLUSTER_DIR)
    ? fs
        .readdirSync(PAPER_CLUSTER_DIR)
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .map((file) => path.join(PAPER_CLUSTER_DIR, file))
    : [];

  const paperCluster = paperFiles.map(summarizePaperConfig);
  const leads = readPromisingLeads();

  if (!realMoney && paperCluster.length === 0 && leads.length === 0) {
    return Response.json({
      available: false,
      reason: 'live forward-tracking outputs have not been produced yet',
    });
  }

  return Response.json({
    available: true,
    generated_utc: realMoney?.generated_utc ?? paperCluster[0]?.updated_utc ?? null,
    realMoney: realMoney
      ? {
          mode: realMoney.mode ?? 'unknown',
          live_equity_usd: Number(realMoney.live_equity_usd ?? 0),
          starting_equity_usd: Number(realMoney.starting_equity_usd ?? 0),
          cumulative_realized_pnl: Number(realMoney.cumulative_realized_pnl ?? 0),
          budget_usd: Number(realMoney.budget_usd ?? 0),
          kill_line_usd: Number(realMoney.kill_line_usd ?? 0),
          halted: Boolean(realMoney.halted),
          position: realMoney.position ?? null,
          position_label: positionLabel(realMoney.position),
          last_event: realMoney.last_event ?? null,
          last_action: lastActionLabel(realMoney.last_event),
        }
      : null,
    paperCluster,
    leads,
    leads_summary: {
      total: leads.length,
      trading: leads.filter((l) => l.status === 'trading').length,
      warming_up: leads.filter((l) => l.status === 'warming up').length,
    },
  });
}
