#!/usr/bin/env node
// feature-reachability.mjs — human-runnable report of FEATURE_* flag call sites by
// layer (daemon/pty = production, cli = manual tool, other = library). Flags any
// flag with NO production (daemon) call site. Guard for INC-2026-06-18.
// Usage: node scripts/feature-reachability.mjs   (run from repo root)

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'src');
const FLAGS = join(REPO, 'orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json');
const MANIFEST = join(REPO, 'orgs/main/agents/jarvis/state/jarvis-core/daemon-live-flags.json');

function walk(dir, out = []) {
  let es; try { es = readdirSync(dir); } catch { return out; }
  for (const e of es) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue; walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const layer = f => f.includes('/src/daemon/') || f.includes('/src/pty/') ? 'daemon'
  : f.includes('/src/cli/') ? 'cli' : 'other';

const flags = existsSync(FLAGS) ? Object.keys(JSON.parse(readFileSync(FLAGS, 'utf-8'))) : [];
const manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf-8')).daemon_live ?? []) : [];
const files = walk(SRC);
const res = Object.fromEntries(flags.map(f => [f, { daemon: 0, cli: 0, other: 0 }]));
for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  for (const flag of flags) {
    if (new RegExp(`isFeatureEnabled\\(\\s*['"]${flag}['"]`).test(text)) res[flag][layer(file.replace(/\\/g, '/'))]++;
  }
}
let bad = 0;
console.log('FEATURE REACHABILITY (daemon=production, cli=manual, other=library)');
for (const flag of flags) {
  const r = res[flag];
  const prod = r.daemon > 0;
  const live = manifest.includes(flag);
  const mark = (live && !prod) ? ' <<< DECLARED DAEMON-LIVE WITH NO PRODUCTION CALL SITE' : (!prod ? ' (no daemon call site)' : '');
  if (live && !prod) bad++;
  console.log(`  ${flag}: daemon=${r.daemon} cli=${r.cli} other=${r.other}${mark}`);
}
console.log(`manifest daemon_live=${JSON.stringify(manifest)}`);
process.exit(bad > 0 ? 1 : 0);
