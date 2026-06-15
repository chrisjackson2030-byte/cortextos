import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../../../src/utils/lock';

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    // Same process, same PID - should fail since lock.d already exists
    // (but our PID check will see it's our own process and succeed)
    // Actually, mkdir will fail because it already exists, then we check PID
    // Since it's our own PID, it sees process alive and returns false
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  // WS4 2026-06-15: regression for the forge-inbox permanent deadlock.
  it('refuses a fresh PID-less lock dir (live mid-acquire holder)', () => {
    // .lock.d exists, no pid file, just created -> caller must retry, not steal.
    mkdirSync(join(testDir, '.lock.d'));
    expect(acquireLock(testDir)).toBe(false);
  });

  it('steals a stale PID-less lock dir older than the grace period', () => {
    // An empty .lock.d with no pid file is a crashed/partial acquire. Before the
    // fix this deadlocked forever; now it is reclaimed once past the grace window.
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    // Backdate the dir's mtime on disk to well past PIDLESS_LOCK_STALE_MS (30s).
    const staleSec = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, staleSec, staleSec);
    expect(statSync(lockDir).mtimeMs).toBeLessThan(Date.now() - 30_000);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });
});
