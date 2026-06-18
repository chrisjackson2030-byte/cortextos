import Database from 'better-sqlite3';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'crypto';
import { join, resolve as resolvePath, sep, isAbsolute } from 'path';
import { realpathSync, existsSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';
import { resolveEnv } from '../utils/env.js';
import type { CompletionEnvelope } from '../types/index.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
//
// The base table predates the daemon completion-contract. New columns are added
// additively (try/catch ALTER) below — never drop a column, never rewrite a row
// in place destructively. `run_token` (raw) is KEPT for back-compat with rows
// written before the migration and with the legacy standalone CLI path. New
// contract rows store ONLY `run_token_hash` (sha256 of the raw token); the raw
// token is never persisted for those rows.

const RUNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    trace_id TEXT,
    run_token TEXT,
    status TEXT,
    result TEXT,
    artifacts TEXT,
    blockers TEXT,
    next_action TEXT,
    emitted_at TEXT,
    created_at TEXT,
    lease_deadline TEXT
  )
`;

// Additive columns introduced by the completion-contract data layer.
// Each is applied via try/catch ALTER (idempotent on existing DBs).
const ADDITIVE_COLUMNS: Array<[string, string]> = [
  ['lease_deadline', 'TEXT'],
  ['origin', "TEXT"],
  ['run_token_hash', 'TEXT'],
  ['token_expires_at', 'TEXT'],
  ['parent_run_id', 'TEXT'],
  ['expected_metric', 'TEXT'],
  ['expected_min', 'REAL'],
  ['expected_unit', 'TEXT'],
  ['expected_artifact_required', 'INTEGER'],
  ['outcome_json', 'TEXT'],
  ['schema_version', 'INTEGER'],
  ['lease_expires_at', 'TEXT'],
  ['last_lease_renewed_at', 'TEXT'],
  ['max_deadline', 'TEXT'],
  ['renewal_count', 'INTEGER'],
  ['signature', 'TEXT'],
];

// Current completion-envelope schema version. Bumped when the canonical
// serialization shape (the HMAC-covered field set) changes.
export const COMPLETION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
//
// Nonterminal: pending, running, blocked. Terminal: completed, failed,
// stalled, cancelled. NOTE: the legacy store wrote status='done' on success
// (and treated 'blocked' as terminal). The new state machine uses 'completed'
// as the canonical success terminal, but 'done' is retained as a terminal
// alias for back-compat with rows/envelopes that still emit it.

export const NONTERMINAL_STATUSES = new Set(['pending', 'running', 'blocked']);
export const TERMINAL_STATUSES = new Set([
  'completed',
  'done', // legacy success alias
  'failed',
  'stalled',
  'cancelled',
]);

// Allowed transitions: from -> set(to). 'done' mirrors 'completed' as a
// reachable success target so the legacy envelope status keeps working.
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(['running']),
  running: new Set(['completed', 'done', 'failed', 'blocked', 'stalled', 'cancelled']),
  blocked: new Set(['running', 'failed', 'cancelled']),
};

/** Is `to` a legal next status given current `from`? Terminal -> anything = false. */
export function isTransitionAllowed(from: string, to: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RunOutcome {
  metric: string;
  value: number;
  unit?: string;
  evidence?: string;
}

export interface ExpectedOutcomeContract {
  metric: string;
  min_expected: number;
  unit?: string;
  artifact_required?: boolean;
}

export interface RunRecord {
  run_id: string;
  trace_id: string | null;
  run_token: string; // raw token for legacy rows; '' for hash-only contract rows
  status: string;
  result: string | null;
  artifacts: string[];
  blockers: string[];
  next_action: string | null;
  emitted_at: string | null;
  created_at: string;
  lease_deadline: string | null;
  // contract fields
  origin: 'daemon' | 'standalone';
  parent_run_id: string | null;
  token_expires_at: string | null;
  expected: ExpectedOutcomeContract | null;
  outcome: RunOutcome | null;
  schema_version: number | null;
  lease_expires_at: string | null;
  last_lease_renewed_at: string | null;
  max_deadline: string | null;
  renewal_count: number | null;
  signature: string | null;
}

export interface RunStartRecord {
  run_id: string;
  run_token: string; // raw token — returned ONCE, never persisted for contract rows
  trace_id: string | null;
}

export interface StartRunOptions {
  origin?: 'daemon' | 'standalone';
  parentRunId?: string;
  traceId?: string;
  leaseSeconds?: number;
  maxLeaseSeconds?: number;
  tokenTtlSeconds?: number;
  expectedOutcome?: ExpectedOutcomeContract;
}

type RawRunRow = {
  run_id: string;
  trace_id: string | null;
  run_token: string | null;
  status: string;
  result: string | null;
  artifacts: string | null;
  blockers: string | null;
  next_action: string | null;
  emitted_at: string | null;
  created_at: string;
  lease_deadline: string | null;
  origin: string | null;
  run_token_hash: string | null;
  token_expires_at: string | null;
  parent_run_id: string | null;
  expected_metric: string | null;
  expected_min: number | null;
  expected_unit: string | null;
  expected_artifact_required: number | null;
  outcome_json: string | null;
  schema_version: number | null;
  lease_expires_at: string | null;
  last_lease_renewed_at: string | null;
  max_deadline: string | null;
  renewal_count: number | null;
  signature: string | null;
};

/**
 * Typed rejection. The data layer NEVER throws-and-crashes on a forbidden
 * transition / bad token / invalid envelope (except the one back-compat case:
 * a plain run_token mismatch on a legacy standalone row still throws
 * 'run_token mismatch' to preserve the existing CLI/test contract).
 */
export interface RunRejection {
  ok: false;
  reason:
    | 'not_found'
    | 'token_mismatch'
    | 'signature_mismatch'
    | 'forbidden_transition'
    | 'terminal_overwrite'
    | 'invalid_envelope'
    | 'token_expired';
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function analyticsDir(): string {
  const env = resolveEnv();
  const orgBase = env.org ? join(env.ctxRoot, 'orgs', env.org) : env.ctxRoot;
  return join(orgBase, 'analytics');
}

/** DB path, overridable for tests via CTX_RUN_STORE_DB (absolute path). */
function runsDbPath(): string {
  const override = process.env.CTX_RUN_STORE_DB;
  if (override && override.trim()) return override;
  return join(analyticsDir(), 'runs.db');
}

function serializeList(values?: string[] | null): string | null {
  return values && values.length > 0 ? JSON.stringify(values) : null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseOutcome(value: string | null): RunOutcome | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as Partial<RunOutcome>;
    if (o && typeof o.metric === 'string' && typeof o.value === 'number') {
      return {
        metric: o.metric,
        value: o.value,
        unit: typeof o.unit === 'string' ? o.unit : undefined,
        evidence: typeof o.evidence === 'string' ? o.evidence : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Constant-time hex-string compare; false on length mismatch (no throw). */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function toRunRecord(row: RawRunRow | undefined): RunRecord | null {
  if (!row) return null;
  const expected: ExpectedOutcomeContract | null =
    row.expected_metric !== null && row.expected_min !== null
      ? {
          metric: row.expected_metric,
          min_expected: row.expected_min,
          unit: row.expected_unit ?? undefined,
          artifact_required: row.expected_artifact_required === 1 ? true : row.expected_artifact_required === 0 ? false : undefined,
        }
      : null;
  return {
    run_id: row.run_id,
    trace_id: row.trace_id,
    run_token: row.run_token ?? '',
    status: row.status,
    result: row.result,
    artifacts: parseList(row.artifacts),
    blockers: parseList(row.blockers),
    next_action: row.next_action,
    emitted_at: row.emitted_at,
    created_at: row.created_at,
    lease_deadline: row.lease_deadline,
    origin: (row.origin as 'daemon' | 'standalone') ?? 'standalone',
    parent_run_id: row.parent_run_id,
    token_expires_at: row.token_expires_at,
    expected,
    outcome: parseOutcome(row.outcome_json),
    schema_version: row.schema_version,
    lease_expires_at: row.lease_expires_at,
    last_lease_renewed_at: row.last_lease_renewed_at,
    max_deadline: row.max_deadline,
    renewal_count: row.renewal_count,
    signature: row.signature,
  };
}

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T | null {
  let db: InstanceType<typeof Database> | null = null;
  try {
    const path = runsDbPath();
    ensureDir(join(path, '..'));
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.exec(RUNS_SCHEMA);
    for (const [col, type] of ADDITIVE_COLUMNS) {
      try {
        db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
      } catch {
        // Column already exists on this DB.
      }
    }
    return fn(db);
  } catch (err) {
    // Preserve the legacy back-compat throw for a plain run_token mismatch.
    if (err instanceof Error && err.message.startsWith('run_token mismatch')) {
      throw err;
    }
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

// ---------------------------------------------------------------------------
// HMAC / canonical serialization
// ---------------------------------------------------------------------------
//
// The envelope signature is HMAC-SHA256(rawToken, canonicalSerialize(payload)).
// Payload covers EVERY mutable field the worker can assert:
//   { schema_version, run_id, trace_id, status, result, artifacts,
//     blockers, next_action, outcome, emitted_at }
// Canonical serialization = JSON with recursively sorted object keys and a
// fixed value normalization (undefined fields dropped, arrays preserved in
// order, nested objects key-sorted). This makes the signature deterministic
// and independent of property insertion order, so any tamper of any covered
// field changes the bytes and therefore the HMAC.

export interface EnvelopePayload {
  schema_version: number;
  run_id: string;
  trace_id: string | null;
  status: string;
  result: string | null;
  artifacts: string[];
  blockers: string[];
  next_action: string | null;
  outcome: RunOutcome | null;
  emitted_at: string;
}

/** Deterministic JSON: object keys sorted recursively, arrays order-preserved. */
function canonicalSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // drop undefined for stability
    out[key] = sortValue(v);
  }
  return out;
}

/** Build the canonical payload from an envelope (normalizes optional fields). */
export function envelopePayload(envelope: CompletionEnvelope): EnvelopePayload {
  const env = envelope as CompletionEnvelope & {
    trace_id?: string | null;
    outcome?: RunOutcome | null;
    schema_version?: number;
  };
  return {
    schema_version: typeof env.schema_version === 'number' ? env.schema_version : COMPLETION_SCHEMA_VERSION,
    run_id: envelope.run_id,
    trace_id: env.trace_id ?? null,
    status: envelope.status,
    result: envelope.result ?? null,
    artifacts: envelope.artifacts ?? [],
    blockers: envelope.blockers ?? [],
    next_action: envelope.next_action ?? null,
    outcome: env.outcome ?? null,
    emitted_at: envelope.emitted_at,
  };
}

/**
 * Sign an envelope payload. ONE shared impl for the worker-side completion
 * helper and the daemon verifier. Returns the hex HMAC.
 */
export function signEnvelope(rawToken: string, payload: EnvelopePayload): string {
  return createHmac('sha256', rawToken).update(canonicalSerialize(payload), 'utf8').digest('hex');
}

/**
 * Verify an envelope's signature against the raw token. Constant-time compare.
 * Returns true only if the recomputed HMAC matches envelope.signature exactly.
 */
export function verifyEnvelope(rawToken: string, envelope: CompletionEnvelope): boolean {
  const expected = signEnvelope(rawToken, envelopePayload(envelope));
  return timingSafeHexEqual(expected, envelope.signature ?? '');
}

// ---------------------------------------------------------------------------
// Outcome + artifact validation
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** Allowed root dir for artifact paths (path-traversal / symlink containment). */
  allowedRoot?: string;
  /** Expected-outcome contract (drives artifact_required check). */
  expected?: ExpectedOutcomeContract | null;
  maxResultBytes?: number;
  maxArtifacts?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const DEFAULT_MAX_RESULT_BYTES = 256 * 1024; // 256KB
const DEFAULT_MAX_ARTIFACTS = 64;

/**
 * Validate an envelope's shape, size, and artifact safety.
 * - JSON-shape check on required fields.
 * - result payload <= maxResultBytes; artifacts count <= maxArtifacts.
 * - URL artifacts: https scheme only.
 * - File-path artifacts: must resolve UNDER allowedRoot (no '..' traversal, no
 *   absolute escape, no symlink escape via realpath). Reject otherwise.
 * - When expected.artifact_required, at least one artifact must exist on disk.
 */
export function validateEnvelope(envelope: CompletionEnvelope, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const maxResultBytes = opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const maxArtifacts = opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;

  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, errors: ['envelope is not an object'] };
  }
  if (typeof envelope.run_id !== 'string' || !envelope.run_id) errors.push('run_id missing');
  if (typeof envelope.status !== 'string' || !envelope.status) errors.push('status missing');
  if (typeof envelope.emitted_at !== 'string' || !envelope.emitted_at) errors.push('emitted_at missing');
  if (typeof envelope.signature !== 'string') errors.push('signature missing');

  if (envelope.result !== undefined && envelope.result !== null) {
    if (typeof envelope.result !== 'string') {
      errors.push('result must be a string');
    } else if (Buffer.byteLength(envelope.result, 'utf8') > maxResultBytes) {
      errors.push(`result exceeds ${maxResultBytes} bytes`);
    }
  }

  const artifacts = envelope.artifacts ?? [];
  if (!Array.isArray(artifacts)) {
    errors.push('artifacts must be an array');
  } else if (artifacts.length > maxArtifacts) {
    errors.push(`artifacts exceed ${maxArtifacts} entries`);
  }

  // Resolve allowed root once (realpath so symlinked roots compare correctly).
  let allowedRootReal: string | null = null;
  if (opts.allowedRoot) {
    try {
      allowedRootReal = realpathSync(opts.allowedRoot);
    } catch {
      allowedRootReal = resolvePath(opts.allowedRoot);
    }
  }

  let fileArtifactCount = 0;
  let existingFileArtifact = false;
  if (Array.isArray(artifacts)) {
    for (const raw of artifacts) {
      if (typeof raw !== 'string') {
        errors.push('artifact entry is not a string');
        continue;
      }
      if (isUrl(raw)) {
        if (!raw.startsWith('https://')) {
          errors.push(`artifact URL must be https: ${raw}`);
        }
        continue;
      }
      // Treat as file path. Containment check requires allowedRoot.
      fileArtifactCount += 1;
      if (allowedRootReal) {
        const verdict = containedPath(raw, allowedRootReal);
        if (!verdict.ok) {
          errors.push(`artifact path escapes allowed root: ${raw} (${verdict.reason})`);
          continue;
        }
        if (verdict.exists) existingFileArtifact = true;
      }
    }
  }

  if (opts.expected?.artifact_required) {
    // Require at least one file artifact that exists on disk.
    if (fileArtifactCount === 0) {
      errors.push('artifact required by contract but none provided');
    } else if (allowedRootReal && !existingFileArtifact) {
      errors.push('artifact required by contract but none exist on disk');
    }
  }

  return { ok: errors.length === 0, errors };
}

function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

/**
 * Returns whether `candidate` resolves under `allowedRootReal`, rejecting
 * '..' traversal, absolute escape, and symlink escape. If the path exists,
 * we realpath it (catches symlinks pointing outside). If it does not exist,
 * we lexically resolve relative to the root and verify containment.
 */
function containedPath(
  candidate: string,
  allowedRootReal: string,
): { ok: boolean; exists: boolean; reason?: string } {
  // Reject absolute paths outright unless they already sit under the root.
  const joined = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(allowedRootReal, candidate);

  // Lexical containment first (defends against '..' even when path is missing).
  if (joined !== allowedRootReal && !joined.startsWith(allowedRootReal + sep)) {
    return { ok: false, exists: false, reason: 'lexical-escape' };
  }

  if (!existsSync(joined)) {
    return { ok: true, exists: false };
  }

  // Path exists: realpath to defeat symlink escape.
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    return { ok: true, exists: false };
  }
  if (real !== allowedRootReal && !real.startsWith(allowedRootReal + sep)) {
    return { ok: false, exists: true, reason: 'symlink-escape' };
  }
  return { ok: true, exists: true };
}

// ---------------------------------------------------------------------------
// Productivity classification
// ---------------------------------------------------------------------------

export type OutcomeClassification = 'PRODUCTIVE' | 'UNPRODUCTIVE' | 'UNHEALTHY' | 'BLOCKED' | 'UNCLASSIFIED';

/**
 * Classify a run's productivity. status=completed NEVER auto-yields healthy:
 * it must pass the outcome check (value>=expected_min and required-artifact
 * present). With no expected contract we DO NOT claim productivity.
 */
export function classifyOutcome(record: RunRecord): OutcomeClassification {
  const status = record.status;
  if (status === 'failed' || status === 'stalled' || status === 'process_exited_without_completion') {
    return 'UNHEALTHY';
  }
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'cancelled') return 'UNHEALTHY';

  const isSuccess = status === 'completed' || status === 'done';
  if (!isSuccess) return 'UNCLASSIFIED';

  // Success terminal. No contract => record state, do NOT claim productivity.
  if (!record.expected) return 'UNCLASSIFIED';

  const required = record.expected.artifact_required === true;
  const artifactPresent = record.artifacts.length > 0;
  if (required && !artifactPresent) return 'UNPRODUCTIVE';

  const value = record.outcome?.value;
  if (typeof value !== 'number') return 'UNPRODUCTIVE';
  if (value >= record.expected.min_expected) return 'PRODUCTIVE';
  return 'UNPRODUCTIVE';
}

// ---------------------------------------------------------------------------
// State transition (atomic compare-and-set)
// ---------------------------------------------------------------------------

/**
 * Atomic conditional transition. UPDATE ... WHERE run_id=? AND status IN(from).
 * Returns true iff exactly one row changed (only one writer wins). The caller
 * is responsible for setting `extraSet` to additional column assignments.
 * This enforces the allowed-transition table at the DB level.
 */
export function attemptTransition(
  db: InstanceType<typeof Database>,
  run_id: string,
  fromStatuses: string[],
  toStatus: string,
  extra: { columns?: Record<string, string | number | null> } = {},
): boolean {
  if (fromStatuses.length === 0) return false;
  // Defense in depth: every from-status must legally reach toStatus.
  for (const from of fromStatuses) {
    if (!isTransitionAllowed(from, toStatus)) return false;
  }
  const cols = extra.columns ?? {};
  const setParts = ['status = ?'];
  const params: Array<string | number | null> = [toStatus];
  for (const [col, val] of Object.entries(cols)) {
    setParts.push(`${col} = ?`);
    params.push(val);
  }
  const placeholders = fromStatuses.map(() => '?').join(', ');
  const sql = `UPDATE runs SET ${setParts.join(', ')} WHERE run_id = ? AND status IN (${placeholders})`;
  const info = db.prepare(sql).run(...params, run_id, ...fromStatuses);
  return info.changes === 1;
}

// ---------------------------------------------------------------------------
// Public data-layer API
// ---------------------------------------------------------------------------

/**
 * Start a run. Two call styles for back-compat:
 *   startRun('trace', 60)                       -> legacy: 8-byte raw token stored
 *   startRun({ origin:'daemon', expectedOutcome }) -> contract: 32-byte token,
 *                                                     ONLY sha256(hash) stored.
 */
export function startRun(traceId?: string, leaseSeconds?: number): RunStartRecord | null;
export function startRun(opts: StartRunOptions): RunStartRecord | null;
export function startRun(
  arg1?: string | StartRunOptions,
  leaseSeconds?: number,
): RunStartRecord | null {
  const opts: StartRunOptions =
    typeof arg1 === 'object' && arg1 !== null
      ? arg1
      : { traceId: arg1, leaseSeconds };

  // Contract mode = any new-style signal present. Legacy mode otherwise.
  const contractMode =
    typeof arg1 === 'object' &&
    arg1 !== null &&
    (arg1.origin === 'daemon' ||
      arg1.expectedOutcome !== undefined ||
      arg1.parentRunId !== undefined ||
      arg1.tokenTtlSeconds !== undefined ||
      arg1.maxLeaseSeconds !== undefined);

  return withDb((db) => {
    const run_id = `run_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const trace_id = opts.traceId ?? null;
    const created_at = nowIso();
    const lease = typeof opts.leaseSeconds === 'number' ? isoFromNow(opts.leaseSeconds) : null;

    if (!contractMode) {
      // Legacy path: 8-byte token stored RAW (back-compat with existing tests/CLI).
      const run_token = randomBytes(8).toString('hex');
      db.prepare(
        `INSERT INTO runs (
          run_id, trace_id, run_token, status, result, artifacts, blockers,
          next_action, emitted_at, created_at, lease_deadline, lease_expires_at,
          origin, schema_version
        ) VALUES (?, ?, ?, 'running', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 'standalone', ?)`,
      ).run(run_id, trace_id, run_token, created_at, lease, lease, COMPLETION_SCHEMA_VERSION);
      return { run_id, run_token, trace_id };
    }

    // Contract path: >=32 random bytes; store ONLY the hash; raw never persisted.
    const raw_token = randomBytes(32).toString('hex');
    const token_hash = sha256Hex(raw_token);
    const origin = opts.origin ?? 'standalone';
    const token_expires_at =
      typeof opts.tokenTtlSeconds === 'number' ? isoFromNow(opts.tokenTtlSeconds) : null;
    const max_deadline =
      typeof opts.maxLeaseSeconds === 'number' ? isoFromNow(opts.maxLeaseSeconds) : null;
    const exp = opts.expectedOutcome ?? null;

    db.prepare(
      `INSERT INTO runs (
        run_id, trace_id, run_token, run_token_hash, token_expires_at, status,
        result, artifacts, blockers, next_action, emitted_at, created_at,
        lease_deadline, lease_expires_at, max_deadline, renewal_count,
        origin, parent_run_id, schema_version,
        expected_metric, expected_min, expected_unit, expected_artifact_required
      ) VALUES (?, ?, NULL, ?, ?, 'running', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run_id,
      trace_id,
      token_hash,
      token_expires_at,
      created_at,
      lease,
      lease,
      max_deadline,
      origin,
      opts.parentRunId ?? null,
      COMPLETION_SCHEMA_VERSION,
      exp ? exp.metric : null,
      exp ? exp.min_expected : null,
      exp?.unit ?? null,
      exp ? (exp.artifact_required ? 1 : 0) : null,
    );
    return { run_id, run_token: raw_token, trace_id };
  });
}

/**
 * Complete a run with an envelope. Verifies token + envelope HMAC, enforces
 * the state machine via an atomic CAS, and is idempotent on a terminal row.
 *
 * Token verification logic:
 *   - If the row has run_token_hash (contract row): sha256(envelope.signature-or-token)
 *     compared via timingSafeEqual to the stored hash, AND the envelope HMAC is
 *     verified with the raw token. The raw token is carried in
 *     `envelope.run_token` (the worker reads CTX_RUN_TOKEN). Legacy callers that
 *     put the raw token in `signature` are also supported as a hash source, but
 *     such a row's HMAC must still match.
 *   - Else (legacy standalone row with raw run_token): plain compare of
 *     envelope.signature === run_token; on mismatch THROW 'run_token mismatch'
 *     (back-compat).
 *
 * Returns the RunRecord on success/idempotent-duplicate, a RunRejection on a
 * rejected completion, or null when the DB is unavailable / row not found.
 */
export function completeRun(
  envelope: CompletionEnvelope & { run_token?: string },
): RunRecord | RunRejection | null {
  return withDb((db) => {
    const select = db.prepare('SELECT * FROM runs WHERE run_id = ?');
    const existing = toRunRecord(select.get(envelope.run_id) as RawRunRow | undefined);
    if (!existing) return null;

    // Idempotent: terminal row is returned unchanged (no overwrite).
    if (TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }

    const rawRow = select.get(envelope.run_id) as RawRunRow;

    // ---- Token + signature verification ----
    if (rawRow.run_token_hash) {
      // Contract row. Find the raw token the caller presented.
      const presentedToken = envelope.run_token ?? envelope.signature ?? '';
      const presentedHash = sha256Hex(presentedToken);
      if (!timingSafeHexEqual(presentedHash, rawRow.run_token_hash)) {
        return { ok: false, reason: 'token_mismatch' } as RunRejection;
      }
      // Token TTL.
      if (rawRow.token_expires_at && rawRow.token_expires_at < nowIso()) {
        return { ok: false, reason: 'token_expired' } as RunRejection;
      }
      // Envelope HMAC must match using the raw token.
      if (!verifyEnvelope(presentedToken, envelope)) {
        return { ok: false, reason: 'signature_mismatch' } as RunRejection;
      }
    } else {
      // Legacy standalone row: plain raw-token compare; throw on mismatch.
      if (envelope.signature !== (rawRow.run_token ?? '')) {
        throw new Error(`run_token mismatch for ${envelope.run_id}`);
      }
    }

    // ---- State machine enforcement (atomic CAS) ----
    const toStatus = envelope.status;
    if (!isTransitionAllowed(existing.status, toStatus)) {
      return { ok: false, reason: 'forbidden_transition', detail: `${existing.status}->${toStatus}` } as RunRejection;
    }

    const env = envelope as CompletionEnvelope & { outcome?: RunOutcome | null };
    const ok = attemptTransition(db, envelope.run_id, [existing.status], toStatus, {
      columns: {
        result: envelope.result ?? null,
        artifacts: serializeList(envelope.artifacts),
        blockers: serializeList(envelope.blockers),
        next_action: envelope.next_action ?? null,
        emitted_at: envelope.emitted_at,
        outcome_json: env.outcome ? JSON.stringify(env.outcome) : null,
        signature: envelope.signature ?? null,
      },
    });

    if (!ok) {
      // Lost the CAS race (another writer transitioned it first). Return the
      // now-current row; if terminal it is the durable result (no overwrite).
      return toRunRecord(select.get(envelope.run_id) as RawRunRow | undefined);
    }

    return toRunRecord(select.get(envelope.run_id) as RawRunRow | undefined);
  });
}

export function getRun(run_id: string): RunRecord | null {
  return withDb((db) =>
    toRunRecord(db.prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id) as RawRunRow | undefined),
  );
}

export function getRunByTrace(trace_id: string): RunRecord | null {
  return withDb((db) =>
    toRunRecord(
      db
        .prepare('SELECT * FROM runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(trace_id) as RawRunRow | undefined,
    ),
  );
}

/**
 * Expire stale running runs whose lease has passed. Atomic conditional
 * UPDATE so exactly one sweeper wins per row. Mirrors lease_deadline (legacy)
 * and lease_expires_at (new) — checks both.
 */
export function expireStaleRuns(): number {
  const result = withDb((db) =>
    db
      .prepare(
        `UPDATE runs
         SET status = 'stalled'
         WHERE status = 'running'
           AND (
             (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
             OR (lease_expires_at IS NULL AND lease_deadline IS NOT NULL AND lease_deadline < ?)
           )`,
      )
      .run(nowIso(), nowIso()).changes,
  );
  return result ?? 0;
}

export function joinRun(run_id: string): RunRecord | null {
  return withDb((db) => {
    const select = db.prepare('SELECT * FROM runs WHERE run_id = ?');
    const existing = toRunRecord(select.get(run_id) as RawRunRow | undefined);
    if (!existing) return null;
    if (TERMINAL_STATUSES.has(existing.status)) return existing;

    const now = nowIso();
    const lease = existing.lease_expires_at ?? existing.lease_deadline;
    if (lease && lease < now) {
      attemptTransition(db, run_id, ['running'], 'stalled');
      return toRunRecord(select.get(run_id) as RawRunRow | undefined);
    }
    return existing;
  });
}
