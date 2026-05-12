// cortextOS Dashboard - Event data fetcher
// Reads from SQLite (synced from JSONL event files on disk).

import { db } from '@/lib/db';
import type { Event } from '@/lib/types';

/**
 * Get recent events, newest first. Supports optional filters.
 */
export function getRecentEvents(
  limit: number = 50,
  org?: string,
  agent?: string,
  category?: string
): Event[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  if (agent) {
    conditions.push('agent = ?');
    params.push(agent);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = db
      .prepare(
        `SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
         FROM events ${where}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map(rowToEvent);
  } catch (err) {
    console.error('[data/events] getRecentEvents error:', err);
    return [];
  }
}

/**
 * Get today's events (UTC), optionally filtered by org/agent.
 */
export function getEventsToday(org?: string, agent?: string): Event[] {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const conditions: string[] = ['timestamp >= ?'];
  const params: (string | number)[] = [todayISO];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  if (agent) {
    conditions.push('agent = ?');
    params.push(agent);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const rows = db
      .prepare(
        `SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
         FROM events ${where}
         ORDER BY timestamp DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToEvent);
  } catch (err) {
    console.error('[data/events] getEventsToday error:', err);
    return [];
  }
}

/**
 * Get events by agent (for agent detail page).
 */
export function getEventsByAgent(agentName: string, limit: number = 50): Event[] {
  return getRecentEvents(limit, undefined, agentName);
}

/**
 * Get events by category (action, error, metric, milestone, etc.).
 */
export function getEventsByCategory(category: string, org?: string): Event[] {
  return getRecentEvents(100, org, undefined, category);
}

/**
 * Get milestone events.
 */
export function getMilestones(org?: string): Event[] {
  return getRecentEvents(100, org, undefined, 'milestone');
}

// ---------------------------------------------------------------------------
// Sparkline data — 24 hourly buckets for MetricCards trend lines
// ---------------------------------------------------------------------------

export interface MetricSparklines {
  tasksCompleted: number[];
  heartbeats: number[];
  approvals: number[];
  blocked: number[];
}

export function getMetricSparklines(org?: string): MetricSparklines {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString();

  // Build 24-element array: index 0 = 24h ago, index 23 = current hour
  function buildBuckets(rows: { hour_key: string; count: number }[]): number[] {
    const map = new Map(rows.map((r) => [r.hour_key, r.count]));
    const buckets: number[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
      buckets.push(map.get(key) ?? 0);
    }
    return buckets;
  }

  const orgClause = org ? 'AND org = ?' : '';
  const orgArg = (org ? [org] : []) as (string | number)[];

  const empty = (): number[] => new Array(24).fill(0);

  try {
    const q = (whereClause: string) =>
      db
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H', timestamp) as hour_key, COUNT(*) as count
           FROM events
           WHERE timestamp >= ? ${whereClause} ${orgClause}
           GROUP BY hour_key`
        )
        .all(sinceISO, ...orgArg) as { hour_key: string; count: number }[];

    return {
      // message='task_completed' covers both action+task event types
      tasksCompleted: buildBuckets(q("AND message = 'task_completed'")),
      heartbeats: buildBuckets(q("AND (type = 'heartbeat' OR category = 'heartbeat')")),
      approvals: buildBuckets(q("AND (message = 'approval_resolved' OR message LIKE '%approval%')")),
      blocked: buildBuckets(q("AND (message LIKE '%blocked%' OR message LIKE '%block%')")),
    };
  } catch {
    return { tasksCompleted: empty(), heartbeats: empty(), approvals: empty(), blocked: empty() };
  }
}

// ---------------------------------------------------------------------------
// Activity heatmap — 30-day daily event counts
// ---------------------------------------------------------------------------

export interface HeatmapDay {
  date: string;  // 'YYYY-MM-DD'
  count: number;
}

export function getActivityHeatmap(org?: string): HeatmapDay[] {
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - 29);
  since.setUTCHours(0, 0, 0, 0);

  const orgClause = org ? 'AND org = ?' : '';
  const orgArg = (org ? [org] : []) as (string | number)[];

  try {
    const rows = db
      .prepare(
        `SELECT date(timestamp) as day, COUNT(*) as count
         FROM events
         WHERE timestamp >= ? ${orgClause}
         GROUP BY day
         ORDER BY day ASC`
      )
      .all(since.toISOString(), ...orgArg) as { day: string; count: number }[];

    const map = new Map(rows.map((r) => [r.day, r.count]));
    const result: HeatmapDay[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      result.push({ date: dateStr, count: map.get(dateStr) ?? 0 });
    }
    return result;
  } catch {
    return Array.from({ length: 30 }, (_, idx) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (29 - idx));
      return { date: d.toISOString().slice(0, 10), count: 0 };
    });
  }
}

/**
 * Get 24 hourly heartbeat-event buckets for a single agent (last 24h).
 * Index 0 = 24h ago, index 23 = current hour.
 */
export function getAgentHeartbeatSparkline(agentName: string): number[] {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString();

  function buildBuckets(rows: { hour_key: string; count: number }[]): number[] {
    const map = new Map(rows.map((r) => [r.hour_key, r.count]));
    const buckets: number[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
      buckets.push(map.get(key) ?? 0);
    }
    return buckets;
  }

  try {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H', timestamp) as hour_key, COUNT(*) as count
         FROM events
         WHERE timestamp >= ?
           AND agent = ?
           AND (type = 'heartbeat' OR category = 'heartbeat')
         GROUP BY hour_key`
      )
      .all(sinceISO, agentName) as { hour_key: string; count: number }[];

    return buildBuckets(rows);
  } catch {
    return new Array(24).fill(0);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToEvent(row: Record<string, unknown>): Event {
  let parsedData: Record<string, unknown> | undefined;
  if (row.data) {
    try {
      parsedData = JSON.parse(row.data as string);
    } catch {
      parsedData = undefined;
    }
  }

  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    agent: row.agent as string,
    org: row.org as string,
    type: row.type as Event['type'],
    category: (row.category as string) ?? '',
    severity: row.severity as Event['severity'],
    data: parsedData,
    message: (row.message as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
}
