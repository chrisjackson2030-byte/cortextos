/**
 * feature-reachability.ts — static guard against declaring a feature LIVE without
 * a production call path. (Incident INC-2026-06-18-features-declared-live-without-prod-call-path.)
 *
 * Scans src/ for `isFeatureEnabled('FLAG')` call sites and classifies each by
 * layer: daemon/pty = PRODUCTION entry point, cli = manual tool, other = library.
 * A daemon feature is only "reachable in production" if it has a daemon/pty call
 * site. The companion test asserts every flag in the daemon-live manifest has one.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type Layer = 'daemon' | 'cli' | 'other';

export interface FlagReachability {
  flag: string;
  daemon: string[];
  cli: string[];
  other: string[];
  productionReachable: boolean; // has at least one daemon/pty call site
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function layerOf(file: string): Layer {
  if (file.includes('/src/daemon/') || file.includes('/src/pty/')) return 'daemon';
  if (file.includes('/src/cli/')) return 'cli';
  return 'other';
}

/**
 * Scan the given src root for isFeatureEnabled('FLAG') call sites of each flag.
 * @param srcRoot absolute path to the src/ directory to scan
 * @param flags   flag names to look for
 */
export function scanFeatureReachability(srcRoot: string, flags: string[]): Record<string, FlagReachability> {
  const files = walk(srcRoot);
  const result: Record<string, FlagReachability> = {};
  for (const flag of flags) {
    result[flag] = { flag, daemon: [], cli: [], other: [], productionReachable: false };
  }
  // match isFeatureEnabled('FLAG') or "FLAG", tolerating whitespace
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    for (const flag of flags) {
      const re = new RegExp(`isFeatureEnabled\\(\\s*['"]${flag}['"]`);
      if (re.test(text)) {
        const layer = layerOf(file.replace(/\\/g, '/'));
        result[flag][layer].push(file);
      }
    }
  }
  for (const flag of flags) {
    result[flag].productionReachable = result[flag].daemon.length > 0;
  }
  return result;
}
