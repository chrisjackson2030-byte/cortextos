// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import type { SSEEvent } from './types';

// Voice console (Phase 1): the B↔agent Telegram transcript lives in two places —
// outbound (agent→B) in the repo's agent state, inbound (B→agent) under CTX_ROOT.
// CORTEXTOS_REPO points at the repo root that holds orgs/<org>/agents/<agent>/state.
const CORTEXTOS_REPO =
  process.env.CORTEXTOS_REPO || path.join(os.homedir(), 'cortextos');

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
  __cortextos_rescan_timer: ReturnType<typeof setInterval> | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch path builder — chokidar v5 dropped glob support, so we resolve
// patterns via fast-glob and pass explicit file paths.
// ---------------------------------------------------------------------------

function getGlobPatterns(): string[] {
  const patterns: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    patterns.push(path.join(orgBase, 'tasks', '**', '*.json'));
    patterns.push(path.join(orgBase, 'approvals', '**', '*.json'));
    patterns.push(path.join(orgBase, 'analytics', 'events', '**', '*.jsonl'));
  }

  patterns.push(path.join(CTX_ROOT, 'state', '*', 'heartbeat.json'));
  patterns.push(path.join(CTX_ROOT, 'inbox', '**', '*.json'));
  patterns.push(path.join(CTX_ROOT, 'logs', '*', 'inbound-messages.jsonl'));
  patterns.push(
    path.join(CORTEXTOS_REPO, 'orgs', '*', 'agents', '*', 'state', 'telegram-outbox.jsonl'),
  );

  return patterns;
}

function resolveWatchPaths(): string[] {
  const patterns = getGlobPatterns();
  try {
    return fg.sync(patterns, { onlyFiles: true, dot: false });
  } catch (err) {
    console.error('[watcher] fast-glob resolution failed:', err);
    return [];
  }
}

/** Read the last non-empty JSON line of a .jsonl file (the just-appended message). */
function readLastJsonl(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Extract a VoiceMessage payload from a changed transcript file, or null. */
function buildMessageData(filePath: string): Record<string, unknown> | null {
  const last = readLastJsonl(filePath);
  if (!last) return null;
  const outbound = filePath.includes('telegram-outbox.jsonl');
  // agent name = the path segment after agents/ (outbound) or logs/ (inbound)
  const m = outbound
    ? filePath.match(/agents\/([^/]+)\/state/)
    : filePath.match(/logs\/([^/]+)\//);
  const text = (last.text as string) || '';
  if (!text) return null;
  return {
    direction: outbound ? 'outbound' : 'inbound',
    agent: m ? m[1] : 'unknown',
    text,
    ts: (last.ts as string) || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('telegram-outbox.jsonl') || filePath.includes('inbound-messages.jsonl'))
    return 'message';
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  return 'sync';
}

function handleFileChange(
  filePath: string,
  changeType: 'change' | 'add' | 'remove',
): void {
  console.log(`[watcher] ${changeType}: ${filePath}`);

  const type = categorizeFilePath(filePath);

  // Sync the changed file to SQLite (skip for deletions + transcript files,
  // which aren't part of the SQLite-backed dashboard data model).
  if (changeType !== 'remove' && type !== 'message') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  // Emit SSE event. Transcript ('message') events carry the parsed message so
  // the /voice page can render the conversation directly from the stream.
  let data: Record<string, unknown> = { filePath, changeType };
  if (type === 'message' && changeType !== 'remove') {
    const msg = buildMessageData(filePath);
    if (!msg) return; // nothing new/parseable — don't emit an empty message
    data = msg;
  }

  const sseEvent: SSEEvent = {
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  emitter.emit('sse', sseEvent);
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = resolveWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  // Periodically re-scan globs to pick up newly created files (new tasks, new agents, etc.)
  const rescanTimer = setInterval(() => {
    try {
      const currentPaths = resolveWatchPaths();
      const watched = new Set(
        Object.entries(watcher.getWatched()).flatMap(([dir, files]) =>
          files.map((f) => path.join(dir, f)),
        ),
      );
      for (const p of currentPaths) {
        if (!watched.has(p)) {
          watcher.add(p);
          console.log(`[watcher] Added new file: ${p}`);
        }
      }
    } catch {
      // Ignore rescan errors
    }
  }, 30_000);
  globalForWatcher.__cortextos_rescan_timer = rescanTimer;

  console.log(
    `[watcher] Watching ${watchPaths.length} resolved paths under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_rescan_timer) {
    clearInterval(globalForWatcher.__cortextos_rescan_timer);
    globalForWatcher.__cortextos_rescan_timer = undefined;
  }
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
