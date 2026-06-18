/**
 * tests/unit/registry-exit-code-classification.test.ts
 *
 * Regression for INC-2026-06-18-reconciler-exit2-misread.
 *
 * THE GUARD: a nonzero exit code is classified FAILURE only if the component's
 * declared `failure_exit_codes` contains it. The reconciler exits 2 by design
 * (drift-detected-and-fixed) — that is a warning/success-with-action, NOT a
 * failure. exit 1 = failure, exit 0 = success.
 *
 * It also asserts the registry record for watchdog.reconciler carries the
 * exit-code contract that matches the verified script convention
 * (desired-state-reconciler.py: 0=clean, 1=error, 2=drift-fixed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyExitCode,
  isFailureExit,
} from '../../src/utils/exit-code-classifier';

const COMPONENTS_PATH = join(
  __dirname,
  '..',
  '..',
  'system-model',
  'components.json',
);

type ComponentRecord = {
  component_id: string;
  type: string;
  success_exit_codes?: number[] | null;
  warning_exit_codes?: number[] | null;
  failure_exit_codes?: number[] | null;
  exit_code_meanings?: Record<string, string> | null;
  last_exit_code?: number | null;
  last_verified_status?: string;
};

function loadComponents(): ComponentRecord[] {
  return JSON.parse(readFileSync(COMPONENTS_PATH, 'utf-8')).components;
}

function reconcilerRecord(): ComponentRecord {
  const rec = loadComponents().find(
    (c) => c.component_id === 'watchdog.reconciler',
  );
  if (!rec) throw new Error('watchdog.reconciler not found in components.json');
  return rec;
}

describe('classifyExitCode (pure helper)', () => {
  const reconciler = {
    success_exit_codes: [0],
    warning_exit_codes: [2],
    failure_exit_codes: [1],
  };

  it('reconciler exit 2 is NOT a failure (drift-fixed = warning)', () => {
    expect(classifyExitCode(reconciler, 2)).toBe('warning');
    expect(isFailureExit(reconciler, 2)).toBe(false);
  });

  it('reconciler exit 1 IS a failure', () => {
    expect(classifyExitCode(reconciler, 1)).toBe('failure');
    expect(isFailureExit(reconciler, 1)).toBe(true);
  });

  it('reconciler exit 0 is success', () => {
    expect(classifyExitCode(reconciler, 0)).toBe('success');
    expect(isFailureExit(reconciler, 0)).toBe(false);
  });

  it('a nonzero code in none of the declared sets is unknown, not failure', () => {
    expect(classifyExitCode(reconciler, 7)).toBe('unknown');
    expect(isFailureExit(reconciler, 7)).toBe(false);
  });

  it('failure_exit_codes takes precedence over other declarations', () => {
    const weird = {
      success_exit_codes: [0, 3],
      warning_exit_codes: [3],
      failure_exit_codes: [3],
    };
    expect(classifyExitCode(weird, 3)).toBe('failure');
  });

  it('a null/empty contract never classifies a nonzero code as failure', () => {
    expect(classifyExitCode(null, 2)).toBe('unknown');
    expect(classifyExitCode({}, 1)).toBe('unknown');
    expect(isFailureExit(undefined, 1)).toBe(false);
  });
});

describe('registry record drives classification (watchdog.reconciler)', () => {
  it('carries the verified exit-code contract (0=clean,1=error,2=drift-fixed)', () => {
    const rec = reconcilerRecord();
    expect(rec.success_exit_codes).toEqual([0]);
    expect(rec.warning_exit_codes).toEqual([2]);
    expect(rec.failure_exit_codes).toEqual([1]);
    expect(rec.exit_code_meanings).toMatchObject({
      '0': 'clean',
      '1': 'error',
      '2': 'drift-fixed',
    });
  });

  it('last observed exit 2 classifies as warning (healthy), not failure', () => {
    const rec = reconcilerRecord();
    expect(rec.last_exit_code).toBe(2);
    expect(classifyExitCode(rec, rec.last_exit_code!)).toBe('warning');
    expect(isFailureExit(rec, rec.last_exit_code!)).toBe(false);
    expect(rec.last_verified_status).toBe('healthy');
  });
});
