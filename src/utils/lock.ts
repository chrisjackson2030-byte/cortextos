import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Grace period (ms) before a PID-less lock directory is treated as stale.
 *
 * WS4 2026-06-15: a crash (or a partial release) between `mkdirSync(lockDir)`
 * and `writeFileSync(pidFile)` can leave a `.lock.d` with NO pid file. The old
 * code returned `false` forever in that case (holder assumed "mid-acquire"),
 * which permanently DEADLOCKED the lock — observed live: forge's bus inbox
 * `.lock.d` (created 00:19Z, empty) blocked `checkInbox` for ~17h so two
 * jarvis->forge messages never drained. A real mkdir->writeFileSync gap is sub-
 * millisecond; anything older than this grace period is a dead holder, never an
 * in-flight one, so it is safe to steal.
 */
const PIDLESS_LOCK_STALE_MS = 30_000;

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Automatically recovers stale locks (dead process).
 */
export function acquireLock(dir: string): boolean {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');

  try {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (err) {
    // Only EEXIST means contention. EACCES / ENOSPC / EROFS / etc. are real
    // filesystem failures — propagate so the caller (withFileLockSync) does
    // not loop forever against a directory that will never be writable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // mkdirSync failed with EEXIST — another process holds (or is mid-acquire
    // of) the lock.  We must NOT treat the gap between mkdirSync and
    // writeFileSync as "stale" — doing so allows two acquirers to interleave
    // and BOTH believe they hold the lock (the actual race that broke iter
    // 12).  When the PID file is missing, the holder is mid-acquire; the
    // caller should retry.
    let storedPidRaw: string;
    try {
      storedPidRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      // PID file not yet written.  Normally the holder is between mkdir and
      // writeFileSync (sub-millisecond) — refuse and let the caller retry.
      // BUT if the lock DIR itself is older than PIDLESS_LOCK_STALE_MS, no live
      // holder is mid-acquire that long: it is a crashed/partial acquire that
      // left an empty .lock.d, which would otherwise deadlock forever (WS4
      // forge-inbox bug). Steal it atomically.
      let lockAgeMs = 0;
      try {
        lockAgeMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        // Lock dir vanished between the EEXIST and the stat — gone, so retry.
        return false;
      }
      if (lockAgeMs < PIDLESS_LOCK_STALE_MS) {
        // Plausibly a live mid-acquire holder. Refuse; caller retries.
        return false;
      }
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        // Another process beat us to the steal — let caller retry.
        return false;
      }
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // Corrupt PID file.  Don't steal — let caller retry; if it persists
      // the holder is broken and a future stale-detection pass (process.kill
      // check below, after the PID is written cleanly) will recover.
      return false;
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead - stale lock, remove and re-acquire atomically.
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        // Another process beat us to the steal — let caller retry.
        return false;
      }
    }
  }
}

/**
 * Release a mutex lock.
 */
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore errors on release
  }
}

/**
 * Inter-process lock options for `withFileLockSync`.
 */
export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

// SharedArrayBuffer + Atomics.wait gives us a clean cross-thread sleep
// from sync code without spinning the CPU.  One module-scoped buffer is
// reused across calls; we never write to it (only sleep on a wait that
// always times out at `ms`).
const SLEEP_SAB  = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

/**
 * Acquire `dir`'s mutex, run `fn`, then release the lock — even if `fn`
 * throws.  Retries with exponential backoff (capped) until `timeoutMs`.
 *
 * Use this around any read-modify-write sequence on a per-agent file
 * (crons.json etc.) so two concurrent processes can't lose each other's
 * mutations between the read and the write (the atomic rename in
 * writeCrons is per-write only — it does NOT make the surrounding
 * read-modify-write transactional).
 *
 * @throws if the lock cannot be acquired within `timeoutMs`.
 */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs    = opts.timeoutMs        ?? 5_000;
  const initBackoff  = opts.initialBackoffMs ?? 5;
  const maxBackoff   = opts.maxBackoffMs     ?? 100;

  // Use process.hrtime.bigint() instead of Date.now() so the timeout works
  // under vi.useFakeTimers() (which freezes Date.now).  hrtime reads the
  // monotonic clock via syscall and is not stubbed by fake-timer libraries.
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  while (!acquireLock(dir)) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${dir}" within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    releaseLock(dir);
  }
}
