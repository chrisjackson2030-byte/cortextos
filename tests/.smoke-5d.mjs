// ITEM 5d — flags-off production-build smoke test.
// Boots the REAL built dist/daemon.js on a throwaway instance with NO feature
// flags file (flags-off => all false => legacy behavior), waits for the IPC
// socket, queries status (health OK), then shuts the daemon down.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const REPO = process.cwd();
const instanceId = `jcv1seamb-smoke-${process.pid}`;
const ctxRoot = join(homedir(), '.cortextos', instanceId);
const sock = join(ctxRoot, 'daemon.sock');
mkdirSync(join(ctxRoot, 'config'), { recursive: true });
mkdirSync(join(ctxRoot, 'logs'), { recursive: true });

const flagsPath = join(tmpdir(), `jcv1seamb-smoke-flags-${process.pid}.json`);
// Intentionally do NOT create the flags file => isFeatureEnabled returns false
// for everything (flags-off).

const env = {
  ...process.env,
  CTX_INSTANCE_ID: instanceId,
  CTX_FRAMEWORK_ROOT: REPO,
  CTX_ORG: 'main',
  CTX_FEATURE_FLAGS_PATH: flagsPath, // points at a non-existent file => all false
};
delete env.CTX_RUN_STORE_DB;

function waitSock(timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const t = () => {
      if (existsSync(sock)) return res();
      if (Date.now() - start > timeoutMs) return rej(new Error('socket timeout'));
      setTimeout(t, 100);
    };
    t();
  });
}

function ipcSend(obj, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const c = net.createConnection(sock);
    let data = '';
    const to = setTimeout(() => { c.destroy(); rej(new Error('ipc timeout')); }, timeoutMs);
    c.on('connect', () => c.write(JSON.stringify(obj)));
    c.on('data', (d) => {
      data += d.toString();
      try { const r = JSON.parse(data); clearTimeout(to); c.end(); res(r); } catch {}
    });
    c.on('error', (e) => { clearTimeout(to); rej(e); });
  });
}

const result = { instanceId, ctxRoot, flagsOff: true };
let daemon;
try {
  daemon = spawn(process.execPath, [join(REPO, 'dist', 'daemon.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  daemon.stdout.on('data', (d) => { bootLog += d.toString(); });
  daemon.stderr.on('data', (d) => { bootLog += d.toString(); });

  await waitSock();
  const status = await ipcSend({ type: 'status', source: 'smoke-5d' });
  const workers = await ipcSend({ type: 'list-workers', source: 'smoke-5d' });

  result.bootContainsRunning = /Running \(pid:/.test(bootLog);
  result.statusSuccess = status?.success === true;
  result.status = status;
  result.workers = workers;
  result.healthOk = result.statusSuccess && result.bootContainsRunning;
} catch (e) {
  result.error = String(e && e.message ? e.message : e);
} finally {
  if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (daemon && !daemon.killed) daemon.kill('SIGKILL');
}

console.log(JSON.stringify(result, null, 2));
// Leave throwaway ctxRoot in place per instructions; clean the temp flags stub.
try { rmSync(flagsPath, { force: true }); } catch {}
process.exit(result.healthOk ? 0 : 1);
