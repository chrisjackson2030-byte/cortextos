// cortextOS Dashboard — /revenue data assembly (B-directed 2026-06-12).
// ONE screen where B sees every revenue/edge thread live, so nothing is
// forgotten in the message flood. All reads are LIVE from disk, server-side,
// and defensive (missing/garbled file => empty section, never a crash).
//
// Sources:
//   - Revenue Director: orgs/main/agents/jarvis/state/revenue-director-{ledger.jsonl,pending-b.json,leash.json}
//   - Idea pipeline:    orgs/main/agents/jarvis/state/pipeline/ideas.jsonl
//   - Edge scoreboard:  orgs/main/agents/jarvis/state/edge-engine-state.json (regenerated each drive cycle)
//                       + ~/cortextos-data/edge-engine/lead_registry.md (lead labels)
//                       + jarvis/deliverables/*study*2026* / *-verdict-* (recent study verdicts)
//   - Shopify:          orgs/main/agents/jarvis/state/shopify-{roadmap.json,pending-b.json,operator-log.jsonl}
//   - Options bot:      ~/.openclaw/workspace/discordbot/state/account-snapshot.json (last-known, NOT a live broker read)
//   - Kalshi:           FROZEN (B directive) — surfaced as a static honest note, no local DB reads.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getFrameworkRoot } from '@/lib/config';

const ORG = 'main';

function jarvisDir(): string {
  return path.join(getFrameworkRoot(), 'orgs', ORG, 'agents', 'jarvis');
}
function stateDir(): string {
  return path.join(jarvisDir(), 'state');
}

function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function readJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonlSafe<T>(p: string): T[] {
  const raw = readSafe(p);
  if (!raw) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* skip garbled line */
    }
  }
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingBItem {
  source: string; // which registry it came from
  track: string;
  ask: string;
  state?: string;
  queued_at?: string;
}

export interface LedgerCycle {
  cycle: string;
  tracks?: string[];
  stalled?: string[];
  chosen_free_push?: string;
  b_gate_count?: number;
  ts?: string;
}

export interface Leash {
  mode?: string;
  free_actions?: string[];
  b_gate_actions?: string[];
  real_money_frozen?: boolean;
  max_free_dispatches_per_cycle?: number;
}

export interface RevenueTrack {
  key: string;
  label: string;
  status: string; // live, derived from that track's own state file where one exists
  status_as_of: string | null; // timestamp of the underlying state read, '' if static
  path_to_profit: string;
  stalled: boolean;
  last_push: string | null; // ts the Revenue Director last chose this track
  pending_b: number; // money/B-gate items queued for this track
}

export interface PipelineIdea {
  slug: string;
  title: string;
  status: string;
  captured_at?: string;
  source?: string;
  verdict?: string | null;
}

export interface RegistryLead {
  bucket: 'live' | 'watch';
  heading: string; // e.g. "VRP — BTC short-vol (rw30/thr10/h7) — NEAR LEAD (tail-heavy) — P ~25%"
}

export interface StudyVerdict {
  file: string;
  date: string; // from filename
  title: string;
  snippet: string;
  mtime: number;
}

export interface RevenuePayload {
  generated_at: string;
  needs_b: PendingBItem[];
  leash: Leash | null;
  tracks: RevenueTrack[];
  director: {
    last_cycle_at: string | null;
    cycles_24h: number;
    recent: LedgerCycle[];
  };
  pipeline: {
    total: number;
    by_status: { status: string; count: number; items: PipelineIdea[] }[];
  };
  edge: {
    attempts: number | null;
    confirmed: number | null;
    scoreboard: string;
    live_lead: string;
    state_generated_at: string | null;
    registry_updated: string | null;
    leads: RegistryLead[];
    dead_count: number;
    verdicts: StudyVerdict[];
  };
  trading: {
    kalshi: string;
    options: {
      status: string;
      equity: number | null;
      options_level: number | null;
      updated_at: string | null;
      kill_switch: boolean;
    } | null;
  };
}

// ── Revenue Director ─────────────────────────────────────────────────────────

function readLedger(): LedgerCycle[] {
  return readJsonlSafe<LedgerCycle>(path.join(stateDir(), 'revenue-director-ledger.jsonl'));
}

function readPendingB(): PendingBItem[] {
  const items: PendingBItem[] = [];

  const rd = readJsonSafe<Omit<PendingBItem, 'source'>[]>(
    path.join(stateDir(), 'revenue-director-pending-b.json'),
  );
  if (Array.isArray(rd)) {
    for (const it of rd) items.push({ source: 'revenue-director', ...it });
  }

  // Shopify operator keeps its own B-gate queue
  const sh = readJsonSafe<{ blocked_on_b?: { action?: string; title?: string; detail?: string }[] }>(
    path.join(stateDir(), 'shopify-pending-b.json'),
  );
  if (sh && Array.isArray(sh.blocked_on_b)) {
    for (const b of sh.blocked_on_b) {
      items.push({
        source: 'shopify-operator',
        track: 'shopify',
        ask: b.title ?? b.detail ?? b.action ?? 'B-gated action',
      });
    }
  }

  return items;
}

// ── Track status (live where a state file exists) ────────────────────────────

function shopifyStatus(): { status: string; as_of: string | null } {
  const roadmap = readJsonSafe<{ store?: { name?: string; note?: string }; updated_at?: string }>(
    path.join(stateDir(), 'shopify-roadmap.json'),
  );
  const log = readJsonlSafe<{ ts?: string; event?: string; title?: string }>(
    path.join(stateDir(), 'shopify-operator-log.jsonl'),
  );
  const last = log.length > 0 ? log[log.length - 1] : null;
  if (!roadmap && !last) return { status: 'no state file found', as_of: null };
  const note = roadmap?.store?.note ?? roadmap?.store?.name ?? '';
  const lastAct = last?.title ? ` Operator last: ${last.title}` : '';
  return {
    status: `${note}${lastAct}`.trim() || 'state present but empty',
    as_of: last?.ts ?? roadmap?.updated_at ?? null,
  };
}

function optionsBotState() {
  const home = process.env.HOME ?? os.homedir();
  const botRoot = path.join(home, '.openclaw/workspace/discordbot');
  const snap = readJsonSafe<{
    status?: string;
    equity?: number;
    options_level?: number;
    updated_at?: string;
  }>(path.join(botRoot, 'state/account-snapshot.json'));
  const killSwitch = fs.existsSync(path.join(botRoot, 'KILL_SWITCH'));
  if (!snap) return { snap: null, killSwitch };
  return { snap, killSwitch };
}

// ── Idea pipeline ────────────────────────────────────────────────────────────

const STATUS_ORDER = [
  'shipped',
  'executing',
  'approved',
  'proposed',
  'researching',
  'classified',
  'captured',
  'parked',
  'killed',
];

function readPipeline(): RevenuePayload['pipeline'] {
  const ideas = readJsonlSafe<PipelineIdea>(path.join(stateDir(), 'pipeline/ideas.jsonl'));
  const groups = new Map<string, PipelineIdea[]>();
  for (const idea of ideas) {
    const s = idea.status || 'unknown';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(idea);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return {
    total: ideas.length,
    by_status: ordered.map((status) => {
      const items = groups.get(status)!;
      // newest first within a status
      items.sort((a, b) => (b.captured_at ?? '').localeCompare(a.captured_at ?? ''));
      return { status, count: items.length, items: items.slice(0, 12) };
    }),
  };
}

// ── Edge scoreboard ──────────────────────────────────────────────────────────

function readEdge(): RevenuePayload['edge'] {
  const state = readJsonSafe<{
    generated_at?: string;
    attempts_logged?: number;
    proven_edges?: number;
    scoreboard?: string;
    live_lead?: string;
  }>(path.join(stateDir(), 'edge-engine-state.json'));

  // lead_registry.md — labels for live/watch leads + dead count
  const dataRoot = process.env.CORTEXTOS_DATA_ROOT ?? path.join(os.homedir(), 'cortextos-data');
  const registryPath = path.join(dataRoot, 'edge-engine/lead_registry.md');
  const reg = readSafe(registryPath);
  const leads: RegistryLead[] = [];
  let deadCount = 0;
  let registryUpdated: string | null = null;
  if (reg) {
    try {
      registryUpdated = new Date(fs.statSync(registryPath).mtimeMs).toISOString();
    } catch {
      /* ignore */
    }
    let bucket: 'live' | 'watch' | 'dead' | null = null;
    for (const line of reg.split('\n')) {
      if (/^##\s/.test(line)) {
        if (/LIVE CANDIDATES/i.test(line)) bucket = 'live';
        else if (/WATCH LIST/i.test(line)) bucket = 'watch';
        else if (/DEAD/i.test(line)) bucket = 'dead';
        else bucket = null;
        continue;
      }
      const m = line.match(/^###\s+\d+\.\s+(.*)$/);
      if (m && (bucket === 'live' || bucket === 'watch')) {
        leads.push({ bucket, heading: m[1].trim() });
      }
      if (bucket === 'dead' && /^-\s+\*\*/.test(line)) deadCount += 1;
    }
  }

  // Recent study/verdict deliverables
  const verdicts: StudyVerdict[] = [];
  const delivDir = path.join(jarvisDir(), 'deliverables');
  try {
    const names = fs
      .readdirSync(delivDir)
      .filter((n) => n.endsWith('.md') && (/study.*2026/i.test(n) || /-verdict-/i.test(n)));
    for (const name of names) {
      const full = path.join(delivDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      const dateM = name.match(/(\d{4}-\d{2}-\d{2})/);
      const text = readSafe(full);
      const lines = text.split('\n');
      const titleLine = lines.find((l) => l.startsWith('# '));
      // snippet: first non-empty paragraph line after a Verdict/Executive Summary heading
      let snippet = '';
      const headIdx = lines.findIndex((l) => /^#{2,3}\s.*(verdict|executive summary)/i.test(l));
      if (headIdx >= 0) {
        for (let i = headIdx + 1; i < Math.min(lines.length, headIdx + 8); i++) {
          const t = lines[i].trim();
          if (t && !t.startsWith('#')) {
            snippet = t.replace(/\*\*/g, '');
            break;
          }
        }
      }
      verdicts.push({
        file: name,
        date: dateM ? dateM[1] : '',
        title: (titleLine ?? name).replace(/^#\s*/, ''),
        snippet: snippet.length > 240 ? snippet.slice(0, 237) + '…' : snippet,
        mtime,
      });
    }
  } catch {
    /* deliverables dir unreadable — leave empty */
  }
  verdicts.sort((a, b) => b.mtime - a.mtime);

  return {
    attempts: state?.attempts_logged ?? null,
    confirmed: state?.proven_edges ?? null,
    scoreboard: state?.scoreboard ?? '',
    live_lead: state?.live_lead ?? '',
    state_generated_at: state?.generated_at ?? null,
    registry_updated: registryUpdated,
    leads,
    dead_count: deadCount,
    verdicts: verdicts.slice(0, 10),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const TRACK_META: Record<string, { label: string; path_to_profit: string }> = {
  shopify: {
    label: 'Shopify — The Quiet Kiln',
    path_to_profit:
      'Organic content (TikTok+YT) → store traffic → burner sales at ~$16 margin. Real checkout gated on Shopify Payments [HUMAN].',
  },
  fiverr: {
    label: 'Fiverr / Digital Products',
    path_to_profit:
      'Products built+zipped → LISTING needs B (account access) → first gig sales. Zero spend until listed.',
  },
  options_bot: {
    label: 'Options Bot (Alpaca)',
    path_to_profit:
      'Copies JPM Discord signals at level-3 caps ($150/$150/1/3). Profit = signal copy alpha; equity is the scoreboard.',
  },
  edge_engine: {
    label: 'Edge Engine (research)',
    path_to_profit:
      'Hunt → funnel → forward-validate → ONLY a confirmed edge unlocks real money (all real-money trading frozen until then).',
  },
};

export function getRevenuePayload(): RevenuePayload {
  const ledger = readLedger();
  const latest = ledger.length > 0 ? ledger[ledger.length - 1] : null;
  const pending = readPendingB();
  const leash = readJsonSafe<Leash>(path.join(stateDir(), 'revenue-director-leash.json'));

  const now = Date.now();
  const cycles24h = ledger.filter((c) => {
    const t = Date.parse(c.ts ?? c.cycle ?? '');
    return !Number.isNaN(t) && now - t < 24 * 3600 * 1000;
  }).length;

  // last time the director pushed each track
  const lastPush: Record<string, string> = {};
  for (const c of ledger) {
    if (c.chosen_free_push) lastPush[c.chosen_free_push] = c.ts ?? c.cycle ?? '';
  }

  const shop = shopifyStatus();
  const { snap, killSwitch } = optionsBotState();
  const edge = readEdge();

  const trackStatus: Record<string, { status: string; as_of: string | null }> = {
    shopify: shop,
    fiverr: (() => {
      const it = pending.find((p) => p.track === 'fiverr' && p.state);
      return it
        ? { status: it.state!, as_of: it.queued_at ?? null }
        : { status: 'No fiverr state on file — see Revenue Director ledger', as_of: null };
    })(),
    options_bot: snap
      ? {
          status: `${snap.status ?? 'unknown'} · equity $${(snap.equity ?? 0).toLocaleString()} (last-known snapshot, not a live broker read)${killSwitch ? ' · KILL_SWITCH ON' : ''}`,
          as_of: snap.updated_at ?? null,
        }
      : { status: 'No account snapshot on disk — see options bot / /options page', as_of: null },
    edge_engine: {
      status: edge.scoreboard || 'edge-engine-state.json missing',
      as_of: edge.state_generated_at,
    },
  };

  const trackKeys = latest?.tracks ?? ['shopify', 'fiverr', 'options_bot', 'edge_engine'];
  const tracks: RevenueTrack[] = trackKeys.map((key) => ({
    key,
    label: TRACK_META[key]?.label ?? key,
    status: trackStatus[key]?.status ?? 'unknown',
    status_as_of: trackStatus[key]?.as_of ?? null,
    path_to_profit: TRACK_META[key]?.path_to_profit ?? '',
    stalled: latest?.stalled?.includes(key) ?? false,
    last_push: lastPush[key] ?? null,
    pending_b: pending.filter((p) => p.track === key).length,
  }));

  return {
    generated_at: new Date().toISOString(),
    needs_b: pending,
    leash,
    tracks,
    director: {
      last_cycle_at: latest?.ts ?? latest?.cycle ?? null,
      cycles_24h: cycles24h,
      recent: ledger.slice(-8).reverse(),
    },
    pipeline: readPipeline(),
    edge,
    trading: {
      kalshi:
        'Kalshi / Sidewinder: FROZEN by B directive (287 real trades, net −$20.99). No live reads.',
      options: snap
        ? {
            status: snap.status ?? 'unknown',
            equity: snap.equity ?? null,
            options_level: snap.options_level ?? null,
            updated_at: snap.updated_at ?? null,
            kill_switch: killSwitch,
          }
        : null,
    },
  };
}
