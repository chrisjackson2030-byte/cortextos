/**
 * tests/unit/daemon/fire-environment.test.ts
 *
 * resolveFireEnvironment classifies a fire's environment from STRUCTURED signals
 * (instance id, CTX_ENVIRONMENT, test runtime) — never by agent name. The key
 * isolation guarantee: a test runtime is never classified 'production', even on
 * the default instance, so test fires cannot resemble production in the shared
 * loop-fire-ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveFireEnvironment } from '../../../src/daemon/cron-execution-log';

describe('resolveFireEnvironment — structured environment classification', () => {
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedCtxEnv: string | undefined;

  beforeEach(() => {
    savedVitest = process.env.VITEST;
    savedNodeEnv = process.env.NODE_ENV;
    savedCtxEnv = process.env.CTX_ENVIRONMENT;
  });
  afterEach(() => {
    if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedCtxEnv === undefined) delete process.env.CTX_ENVIRONMENT; else process.env.CTX_ENVIRONMENT = savedCtxEnv;
  });

  it('CTX_ENVIRONMENT override always wins', () => {
    expect(resolveFireEnvironment('default', 'production')).toBe('production');
    expect(resolveFireEnvironment('default', 'simulation')).toBe('simulation');
    expect(resolveFireEnvironment('jcv1gate12', 'production')).toBe('production');
    expect(resolveFireEnvironment('default', 'test')).toBe('test');
  });

  it('a vitest test runtime is NEVER production, even on the default instance', () => {
    process.env.VITEST = 'true';
    delete process.env.NODE_ENV;
    expect(resolveFireEnvironment('default', undefined)).toBe('test');
  });

  it('NODE_ENV=test is never production on the default instance', () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = 'test';
    expect(resolveFireEnvironment('default', undefined)).toBe('test');
  });

  it('the production daemon (default instance, NOT under a test runtime) is production', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(resolveFireEnvironment('default', undefined)).toBe('production');
  });

  it('a non-default instance is test', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(resolveFireEnvironment('jcv1gate12', undefined)).toBe('test');
  });
});
