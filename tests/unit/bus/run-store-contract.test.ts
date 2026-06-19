import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  startRun,
  completeRun,
  getRun,
  joinRun,
  expireStaleRuns,
  signEnvelope,
  verifyEnvelope,
  envelopePayload,
  validateEnvelope,
  classifyOutcome,
  isTransitionAllowed,
  attemptTransition,
  COMPLETION_SCHEMA_VERSION,
  type RunRecord,
  type RunRejection,
  type EnvelopePayload,
} from '../../../src/bus/run-store';
import type { CompletionEnvelope } from '../../../src/types';

// Helper: build a signed contract envelope for a started run.
function signedEnvelope(
  rawToken: string,
  run_id: string,
  over: Partial<CompletionEnvelope & { outcome?: unknown; trace_id?: string | null }> = {},
): CompletionEnvelope & { run_token: string; outcome?: unknown; trace_id?: string | null } {
  const base = {
    run_id,
    status: 'completed',
    result: 'ok',
    artifacts: [] as string[],
    blockers: [] as string[],
    next_action: undefined as string | undefined,
    emitted_at: '2026-06-18T12:00:00Z',
    ...over,
  };
  const payload: EnvelopePayload = envelopePayload({
    ...base,
    signature: '',
  } as CompletionEnvelope);
  const signature = signEnvelope(rawToken, payload);
  return { ...base, signature, run_token: rawToken } as CompletionEnvelope & {
    run_token: string;
    outcome?: unknown;
    trace_id?: string | null;
  };
}

function isRejection(v: RunRecord | RunRejection | null): v is RunRejection {
  return !!v && typeof v === 'object' && 'ok' in v && (v as RunRejection).ok === false;
}

describe('run-store completion contract', () => {
  let dir: string;
  let dbPath: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-store-contract-'));
    dbPath = join(dir, 'runs.db');
    process.env.CTX_RUN_STORE_DB = dbPath;
    process.env.CTX_ROOT = dir;
    process.env.CTX_ORG = 'main';
    process.env.CTX_AGENT_NAME = 'jarvis';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Token storage + hashing
  // -------------------------------------------------------------------------
  it('mints a >=32-byte token and NEVER stores the raw token (hash only)', () => {
    const started = startRun({ origin: 'daemon', expectedOutcome: { metric: 'm', min_expected: 1 } });
    expect(started).not.toBeNull();
    // 32 bytes hex = 64 chars
    expect(started!.run_token).toMatch(/^[0-9a-f]{64}$/);

    const rec = getRun(started!.run_id);
    // raw token column must be empty for contract rows
    expect(rec!.run_token).toBe('');
    expect(rec!.origin).toBe('daemon');

    // Inspect the raw DB row to assert the raw token is truly absent and a hash present.
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT run_token, run_token_hash FROM runs WHERE run_id = ?').get(started!.run_id);
    db.close();
    expect(row.run_token).toBeNull();
    expect(row.run_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // the hash must NOT equal the raw token
    expect(row.run_token_hash).not.toBe(started!.run_token);
  });

  // -------------------------------------------------------------------------
  // State machine: allowed + forbidden
  // -------------------------------------------------------------------------
  it('encodes the allowed-transition table', () => {
    expect(isTransitionAllowed('pending', 'running')).toBe(true);
    expect(isTransitionAllowed('running', 'completed')).toBe(true);
    expect(isTransitionAllowed('running', 'failed')).toBe(true);
    expect(isTransitionAllowed('running', 'blocked')).toBe(true);
    expect(isTransitionAllowed('running', 'stalled')).toBe(true);
    expect(isTransitionAllowed('running', 'cancelled')).toBe(true);
    expect(isTransitionAllowed('blocked', 'running')).toBe(true);
    expect(isTransitionAllowed('blocked', 'failed')).toBe(true);
    // forbidden
    expect(isTransitionAllowed('completed', 'failed')).toBe(false);
    expect(isTransitionAllowed('failed', 'completed')).toBe(false);
    expect(isTransitionAllowed('stalled', 'completed')).toBe(false);
    expect(isTransitionAllowed('cancelled', 'completed')).toBe(false);
    expect(isTransitionAllowed('pending', 'completed')).toBe(false);
  });

  it('attemptTransition CAS: only one writer wins, terminal->* refused', () => {
    const Database = require('better-sqlite3');
    const started = startRun({ origin: 'daemon' });
    const db = new Database(dbPath);
    // running -> completed succeeds once
    expect(attemptTransition(db, started!.run_id, ['running'], 'completed')).toBe(true);
    // second attempt from 'running' loses (row is now completed)
    expect(attemptTransition(db, started!.run_id, ['running'], 'completed')).toBe(false);
    // terminal -> anything refused by the allowed-table guard
    expect(attemptTransition(db, started!.run_id, ['completed'], 'failed')).toBe(false);
    db.close();
  });

  // -------------------------------------------------------------------------
  // HMAC covers every mutable field
  // -------------------------------------------------------------------------
  it('verifyEnvelope rejects tampering of any covered field', () => {
    const token = 'a'.repeat(64);
    const good = signedEnvelope(token, 'run_x', {
      result: 'r',
      artifacts: ['a1'],
      blockers: ['b1'],
      next_action: 'na',
      outcome: { metric: 'm', value: 5 },
      emitted_at: '2026-06-18T12:00:00Z',
      status: 'completed',
    });
    expect(verifyEnvelope(token, good)).toBe(true);

    const fields: Array<Partial<CompletionEnvelope & { outcome?: unknown }>> = [
      { artifacts: ['TAMPERED'] },
      { blockers: ['TAMPERED'] },
      { next_action: 'TAMPERED' },
      { outcome: { metric: 'm', value: 999 } },
      { emitted_at: '2026-06-18T13:00:00Z' },
      { status: 'failed' },
      { result: 'TAMPERED' },
    ];
    for (const f of fields) {
      const tampered = { ...good, ...f } as CompletionEnvelope;
      expect(verifyEnvelope(token, tampered)).toBe(false);
    }
  });

  it('canonical serialization is key-order independent', () => {
    const token = 'b'.repeat(64);
    const p1 = envelopePayload({
      run_id: 'r', status: 'completed', result: 'x', artifacts: ['a'], blockers: ['b'],
      next_action: 'n', signature: '', emitted_at: 't',
    } as CompletionEnvelope);
    // build an envelope with the same fields but different property order
    const sigA = signEnvelope(token, p1);
    const reordered: EnvelopePayload = {
      emitted_at: 't', outcome: null, next_action: 'n', blockers: ['b'],
      artifacts: ['a'], result: 'x', status: 'completed', trace_id: null,
      run_id: 'r', schema_version: COMPLETION_SCHEMA_VERSION,
    };
    const sigB = signEnvelope(token, reordered);
    expect(sigA).toBe(sigB);
  });

  // -------------------------------------------------------------------------
  // completeRun end-to-end + token rejections
  // -------------------------------------------------------------------------
  it('completes a contract run with valid token + signature', () => {
    const started = startRun({ origin: 'daemon', expectedOutcome: { metric: 'pnl', min_expected: 10 } });
    const env = signedEnvelope(started!.run_token, started!.run_id, {
      status: 'completed',
      result: 'done',
      outcome: { metric: 'pnl', value: 12 },
    });
    const res = completeRun(env);
    expect(isRejection(res)).toBe(false);
    expect((res as RunRecord).status).toBe('completed');
    expect((res as RunRecord).outcome).toMatchObject({ metric: 'pnl', value: 12 });
  });

  it('rejects a wrong token (timingSafe) without state change', () => {
    const started = startRun({ origin: 'daemon' });
    const wrongToken = 'f'.repeat(64);
    const env = signedEnvelope(wrongToken, started!.run_id, { status: 'completed' });
    const res = completeRun(env);
    expect(isRejection(res)).toBe(true);
    expect((res as RunRejection).reason).toBe('token_mismatch');
    // run unchanged
    expect(getRun(started!.run_id)!.status).toBe('running');
  });

  it('rejects valid token but tampered signature (HMAC mismatch)', () => {
    const started = startRun({ origin: 'daemon' });
    const env = signedEnvelope(started!.run_token, started!.run_id, { status: 'completed' });
    env.artifacts = ['INJECTED-AFTER-SIGNING'];
    const res = completeRun(env);
    expect(isRejection(res)).toBe(true);
    expect((res as RunRejection).reason).toBe('signature_mismatch');
    expect(getRun(started!.run_id)!.status).toBe('running');
  });

  it('token is scoped to one run — cannot complete a different run', () => {
    const runA = startRun({ origin: 'daemon' });
    const runB = startRun({ origin: 'daemon' });
    // Sign an envelope for runB using runA's token.
    const env = signedEnvelope(runA!.run_token, runB!.run_id, { status: 'completed' });
    const res = completeRun(env);
    expect(isRejection(res)).toBe(true);
    expect((res as RunRejection).reason).toBe('token_mismatch');
    expect(getRun(runB!.run_id)!.status).toBe('running');
  });

  it('idempotent: duplicate completion does not overwrite', () => {
    const started = startRun({ origin: 'daemon' });
    const env1 = signedEnvelope(started!.run_token, started!.run_id, {
      status: 'completed', result: 'first',
    });
    const first = completeRun(env1) as RunRecord;
    expect(first.result).toBe('first');

    const env2 = signedEnvelope(started!.run_token, started!.run_id, {
      status: 'completed', result: 'SECOND-SHOULD-NOT-WIN',
    });
    const second = completeRun(env2) as RunRecord;
    expect(second.result).toBe('first');
  });

  it('late completion after terminal (stalled/failed/cancelled/completed) is rejected', () => {
    // stalled then late complete
    const started = startRun({ origin: 'daemon', leaseSeconds: -1 });
    expect(expireStaleRuns()).toBe(1);
    expect(getRun(started!.run_id)!.status).toBe('stalled');

    const env = signedEnvelope(started!.run_token, started!.run_id, { status: 'completed' });
    const res = completeRun(env);
    // terminal row returned unchanged (idempotent terminal guard), still stalled
    expect((res as RunRecord).status).toBe('stalled');
    expect(getRun(started!.run_id)!.status).toBe('stalled');
  });

  it('cannot resurrect a failed run into completed', () => {
    const started = startRun({ origin: 'daemon' });
    const failEnv = signedEnvelope(started!.run_token, started!.run_id, { status: 'failed', result: 'boom' });
    expect((completeRun(failEnv) as RunRecord).status).toBe('failed');

    const reviveEnv = signedEnvelope(started!.run_token, started!.run_id, { status: 'completed', result: 'revived' });
    const res = completeRun(reviveEnv) as RunRecord;
    expect(res.status).toBe('failed');
    expect(res.result).toBe('boom');
  });

  // -------------------------------------------------------------------------
  // Artifact validation: traversal + symlink + url scheme
  // -------------------------------------------------------------------------
  it('rejects path-traversal artifacts', () => {
    const allowedRoot = join(dir, 'allowed');
    mkdirSync(allowedRoot, { recursive: true });
    const env: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: ['../escape.txt', '../../etc/passwd'],
    };
    const v = validateEnvelope(env, { allowedRoot });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('escapes allowed root'))).toBe(true);
  });

  it('rejects absolute-path escape', () => {
    const allowedRoot = join(dir, 'allowed2');
    mkdirSync(allowedRoot, { recursive: true });
    const env: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: ['/etc/hosts'],
    };
    const v = validateEnvelope(env, { allowedRoot });
    expect(v.ok).toBe(false);
  });

  it('rejects symlink escape', () => {
    const allowedRoot = join(dir, 'allowed3');
    mkdirSync(allowedRoot, { recursive: true });
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'secret');
    const link = join(allowedRoot, 'link.txt');
    symlinkSync(outside, link);
    const env: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: ['link.txt'],
    };
    const v = validateEnvelope(env, { allowedRoot });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('symlink-escape'))).toBe(true);
  });

  it('accepts a contained artifact and https urls; rejects non-https url', () => {
    const allowedRoot = join(dir, 'allowed4');
    mkdirSync(allowedRoot, { recursive: true });
    writeFileSync(join(allowedRoot, 'report.md'), 'hi');

    const okEnv: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: ['report.md', 'https://example.com/x'],
    };
    expect(validateEnvelope(okEnv, { allowedRoot }).ok).toBe(true);

    const badUrl: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: ['http://insecure.example.com'],
    };
    const v = validateEnvelope(badUrl, { allowedRoot });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('https'))).toBe(true);
  });

  it('enforces required-artifact existence', () => {
    const allowedRoot = join(dir, 'allowed5');
    mkdirSync(allowedRoot, { recursive: true });
    // required but no artifact at all
    const noneEnv: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't', artifacts: [],
    };
    expect(validateEnvelope(noneEnv, { allowedRoot, expected: { metric: 'm', min_expected: 1, artifact_required: true } }).ok).toBe(false);

    // required + present-but-missing-on-disk
    const missingEnv: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't', artifacts: ['ghost.md'],
    };
    expect(validateEnvelope(missingEnv, { allowedRoot, expected: { metric: 'm', min_expected: 1, artifact_required: true } }).ok).toBe(false);

    // required + present-and-exists
    writeFileSync(join(allowedRoot, 'real.md'), 'x');
    const goodEnv: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't', artifacts: ['real.md'],
    };
    expect(validateEnvelope(goodEnv, { allowedRoot, expected: { metric: 'm', min_expected: 1, artifact_required: true } }).ok).toBe(true);
  });

  it('enforces result size + artifact count limits', () => {
    const big = 'x'.repeat(300 * 1024);
    const env: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't', result: big,
    };
    expect(validateEnvelope(env).ok).toBe(false);

    const many: CompletionEnvelope = {
      run_id: 'r', status: 'completed', signature: 's', emitted_at: 't',
      artifacts: Array.from({ length: 65 }, (_, i) => `https://x/${i}`),
    };
    expect(validateEnvelope(many).ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Productivity classification
  // -------------------------------------------------------------------------
  it('classifies PRODUCTIVE / UNPRODUCTIVE / UNHEALTHY / BLOCKED', () => {
    const base: RunRecord = {
      run_id: 'r', trace_id: null, run_token: '', status: 'completed', result: null,
      artifacts: [], blockers: [], next_action: null, emitted_at: null, created_at: 't',
      lease_deadline: null, origin: 'daemon', parent_run_id: null, token_expires_at: null,
      expected: { metric: 'pnl', min_expected: 10 }, outcome: { metric: 'pnl', value: 12 },
      schema_version: 1, lease_expires_at: null, last_lease_renewed_at: null,
      max_deadline: null, renewal_count: 0, signature: null,
    };
    expect(classifyOutcome(base)).toBe('PRODUCTIVE');

    // not satisfied
    expect(classifyOutcome({ ...base, outcome: { metric: 'pnl', value: 3 } })).toBe('UNPRODUCTIVE');

    // required artifact missing
    expect(
      classifyOutcome({
        ...base,
        expected: { metric: 'pnl', min_expected: 10, artifact_required: true },
        artifacts: [],
        outcome: { metric: 'pnl', value: 12 },
      }),
    ).toBe('UNPRODUCTIVE');

    // failed / stalled / exit-without-completion = UNHEALTHY
    expect(classifyOutcome({ ...base, status: 'failed' })).toBe('UNHEALTHY');
    expect(classifyOutcome({ ...base, status: 'stalled' })).toBe('UNHEALTHY');
    expect(classifyOutcome({ ...base, status: 'process_exited_without_completion' })).toBe('UNHEALTHY');

    // blocked
    expect(classifyOutcome({ ...base, status: 'blocked' })).toBe('BLOCKED');

    // completed but NO contract => never claims productivity
    expect(classifyOutcome({ ...base, expected: null })).toBe('UNCLASSIFIED');
  });

  it('status=completed never auto-yields PRODUCTIVE without the outcome check', () => {
    const rec: RunRecord = {
      run_id: 'r', trace_id: null, run_token: '', status: 'completed', result: 'done',
      artifacts: [], blockers: [], next_action: null, emitted_at: null, created_at: 't',
      lease_deadline: null, origin: 'daemon', parent_run_id: null, token_expires_at: null,
      expected: { metric: 'pnl', min_expected: 10 }, outcome: null, // no measured value
      schema_version: 1, lease_expires_at: null, last_lease_renewed_at: null,
      max_deadline: null, renewal_count: 0, signature: null,
    };
    expect(classifyOutcome(rec)).toBe('UNPRODUCTIVE');
  });
});
