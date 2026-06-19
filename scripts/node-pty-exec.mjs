#!/usr/bin/env node
// Ensure the node-pty prebuilt spawn-helper is executable.
//
// ROOT CAUSE (node-pty@1.1.0): the published npm tarball ships
//   prebuilds/<platform>/spawn-helper as 0644 (no exec bit), and node-pty's own
//   postinstall (scripts/post-install.js) only chmods files under build/Release/
//   (the node-gyp rebuild path). On a machine that uses the PREBUILT helper
//   (e.g. darwin-arm64), build/Release/ does not exist, so node-pty never chmods
//   the helper it actually uses. Result: every clean `npm ci` leaves
//   prebuilds/*/spawn-helper non-executable and node-pty's PTY spawn fails with
//   `posix_spawnp failed`. This is reproducible, not a one-off copy artifact.
//
// This safeguard fixes ONLY the exact, package-owned node-pty spawn-helper files.
// It never does a recursive chmod over node_modules.
//
// Modes:
//   --fix   (default; wired as the root package postinstall): chmod 0755 each
//           present node-pty spawn-helper that is not already executable.
//   --check (release gate; run BEFORE a daemon restart/cutover): exit 1 if any
//           present node-pty spawn-helper is not executable. Fails closed so a
//           restart cannot proceed onto a daemon that can't spawn workers.

import { existsSync, statSync, chmodSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ptyDir = join(root, 'node_modules', 'node-pty');

// The exact package-owned helper files — explicit list, never a recursive walk.
const candidates = [
  join(ptyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  join(ptyDir, 'prebuilds', 'darwin-x64', 'spawn-helper'),
  join(ptyDir, 'build', 'Release', 'spawn-helper'),
];

const EXEC = constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH;
const isCheck = process.argv.includes('--check');
const present = candidates.filter(existsSync);

if (present.length === 0) {
  console.log('[node-pty-exec] no node-pty spawn-helper present; nothing to do');
  process.exit(0);
}

if (isCheck) {
  const bad = present.filter((f) => (statSync(f).mode & EXEC) === 0);
  if (bad.length) {
    console.error('[node-pty-exec] RELEASE CHECK FAILED — spawn-helper not executable:');
    for (const f of bad) console.error('  ' + f);
    console.error('Run `node scripts/node-pty-exec.mjs --fix` (or `npm ci` with scripts enabled) before restarting.');
    process.exit(1);
  }
  console.log(`[node-pty-exec] release check OK: ${present.length} spawn-helper(s) executable`);
  process.exit(0);
}

// --fix
let fixed = 0;
for (const f of present) {
  if ((statSync(f).mode & EXEC) === 0) {
    chmodSync(f, 0o755);
    console.log('[node-pty-exec] chmod 0755 ' + f);
    fixed++;
  }
}
console.log(`[node-pty-exec] fix complete: ${fixed} helper(s) chmod'd, ${present.length - fixed} already executable`);
process.exit(0);
