/**
 * tests/unit/daemon/fire-ledger-dedup.test.ts
 *
 * Phase 4 fire-ledger isolation (2026-06-18).
 *
 * Proves production duplicate-detection isolates production from non-production
 * fires by the STRUCTURED `environment` field, NOT by recognizing test agent
 * names:
 *   (a) a production fire + a SAME-SECOND test fire are NOT a production dup.
 *   (b) two production fires, same schedule_id + same fire window, ARE a dup.
 *   (c) an unmarked record (no environment) is surfaced for investigation,
 *       not silently treated as production.
 *
 * Deterministic: records are built in-memory; no live ledger, no clock.
 */

import { describe, it, expect } from 'vitest';
import {
  detectProductionDuplicates,
  type FireLedgerRecordLike,
} from '../../../src/daemon/fire-ledger-dedup';

function rec(over: Partial<FireLedgerRecordLike>): FireLedgerRecordLike {
  return {
    name: 'heartbeat',
    source: 'daemon-cron-fire',
    agent: 'jarvis',
    agent_id: 'jarvis',
    schedule_id: 'heartbeat',
    instance_id: 'default',
    environment: 'production',
    triggered_by: 'scheduler',
    timestamp: '2026-06-18T12:00:00Z',
    ts: '2026-06-18T12:00:00Z',
    fire_id: 'heartbeat:default:2026-06-18T12:00:00Z:abcd',
    ...over,
  };
}

describe('fire-ledger-dedup: production isolation by structured field', () => {
  it('(a) a production fire and a SAME-SECOND test fire are NOT a production duplicate', () => {
    // Same schedule_id, same second — but one is environment=test. Note the test
    // record even shares the SAME agent name to prove isolation is by FIELD, not name.
    const records: FireLedgerRecordLike[] = [
      rec({ environment: 'production', timestamp: '2026-06-18T12:00:00Z' }),
      rec({ environment: 'test', instance_id: 'e2e-123', timestamp: '2026-06-18T12:00:00Z' }),
    ];

    const result = detectProductionDuplicates(records);

    expect(result.duplicates).toHaveLength(0);
    expect(result.productionConsidered).toBe(1); // only the production record counts
    expect(result.unmarked).toHaveLength(0);
  });

  it('(b) two production fires, same schedule_id and same fire window, ARE a duplicate', () => {
    const records: FireLedgerRecordLike[] = [
      rec({ environment: 'production', timestamp: '2026-06-18T12:00:00Z', fire_id: 'a' }),
      rec({ environment: 'production', timestamp: '2026-06-18T12:00:00Z', fire_id: 'b' }),
    ];

    const result = detectProductionDuplicates(records);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].schedule_id).toBe('heartbeat');
    expect(result.duplicates[0].records).toHaveLength(2);
    expect(result.productionConsidered).toBe(2);
  });

  it('(c) an unmarked record (no environment) is surfaced for investigation, not treated as production', () => {
    const noEnv = rec({ timestamp: '2026-06-18T12:00:00Z' });
    delete noEnv.environment;

    const records: FireLedgerRecordLike[] = [
      rec({ environment: 'production', timestamp: '2026-06-18T12:00:00Z' }),
      noEnv,
    ];

    const result = detectProductionDuplicates(records);

    // The unmarked record is surfaced...
    expect(result.unmarked).toHaveLength(1);
    expect(result.unmarked[0]).toBe(noEnv);
    // ...and was NOT counted as production (so no false duplicate with the prod fire).
    expect(result.productionConsidered).toBe(1);
    expect(result.duplicates).toHaveLength(0);
  });
});
