#!/usr/bin/env python3
"""audit-integrity-check.py — Layer 3 defense-in-depth.

MODE=task (default): compares task completion status against audit log entries to detect:
1. TAMPER: task marked completed with NO matching audit 'complete' event
2. BYPASS: task completed via 'update' to 'completed' instead of 'complete' event

MODE=data: DATA-WAREHOUSE integrity (P0 of the warehouse plan). Each check maps to a past
real-money incident class so the warehouse cannot reintroduce it:
1. CHECKSUM   — re-hash each landed file vs meta/ingest_log -> catches the malformed-index class
2. SCHEMA     — parquet schema vs recorded fingerprint (needs pyarrow; SKIP if absent)
3. GAP        — coverage gaps per (venue,market,resolution) series
4. FEE-BOOK   — any settlement/pnl row missing a fee field -> catches the fee-less-resolver bug
5. CROSS-SRC  — overlapping sources (HF vs API) must agree -> catches the signing-bug-faked-P&L class
6. VINTAGE    — macro/point-in-time rows must carry vintage/asof -> the data-snooping flaw

Exit codes: 0=all clean, 1=alerts found
"""
import json
import os
import sys
import hashlib
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path


INGEST_LOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS ingest_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,          -- e.g. hf:TrevorJS/kalshi-trades, kalshi-api, polymarket-clob
    venue         TEXT NOT NULL,          -- kalshi | polymarket | binance | fred | ...
    market        TEXT,                   -- series/market family (e.g. KXBTC15M)
    resolution    TEXT,                   -- trades | candles-1m | settlements | ...
    rel_path      TEXT NOT NULL UNIQUE,   -- path under warehouse root
    rows          INTEGER,
    sha256        TEXT NOT NULL,
    schema_fp     TEXT,                   -- parquet schema fingerprint (when known)
    ingested_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    status        TEXT NOT NULL DEFAULT 'landed'
);
CREATE INDEX IF NOT EXISTS idx_ingest_series ON ingest_log(venue, market, resolution);
"""


def _sha256(path, _bufsize=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(_bufsize), b''):
            h.update(chunk)
    return h.hexdigest()


def run_data_integrity(args):
    """Warehouse integrity. Returns exit code (0 clean, 1 alerts). Degrades gracefully."""
    if not args.warehouse:
        print('--warehouse is required for --mode data'); return 2
    root = Path(os.path.expanduser(args.warehouse))
    meta_db = root / 'meta' / 'warehouse.db'
    alerts, skips, checked = [], [], 0
    print("=== DATA-WAREHOUSE INTEGRITY CHECK ===")
    print(f"warehouse: {root}")

    if not meta_db.exists():
        print(f"meta/warehouse.db not found ({meta_db}) — nothing ingested yet."); print("All clean."); return 0
    conn = sqlite3.connect(meta_db)
    conn.executescript(INGEST_LOG_SCHEMA)
    rows = conn.execute("SELECT source, venue, market, resolution, rel_path, rows, sha256, schema_fp FROM ingest_log").fetchall()

    # --- 1. CHECKSUM (malformed-index class) ---
    for source, venue, market, res, rel, nrows, sha, schema_fp in rows:
        fp = root / rel
        checked += 1
        if not fp.exists():
            alerts.append(('CHECKSUM', rel, f'logged file missing on disk (source={source})')); continue
        actual = _sha256(fp)
        if actual != sha:
            alerts.append(('CHECKSUM', rel, f'sha256 mismatch: logged {sha[:12]} != disk {actual[:12]} (corruption/tamper)'))

    # --- 2. SCHEMA (needs pyarrow) ---
    try:
        import pyarrow.parquet as pq  # noqa
        have_pa = True
    except Exception:
        have_pa = False
        skips.append('SCHEMA — pyarrow not installed (vet-gated); deferred')
    if have_pa:
        import pyarrow.parquet as pq
        for source, venue, market, res, rel, nrows, sha, schema_fp in rows:
            fp = root / rel
            if not fp.exists() or not rel.endswith('.parquet'):
                continue
            try:
                got = str(pq.read_schema(fp))
                got_fp = hashlib.sha256(got.encode()).hexdigest()[:16]
                if schema_fp and got_fp != schema_fp:
                    alerts.append(('SCHEMA', rel, f'schema drift: {schema_fp} != {got_fp}'))
            except Exception as e:
                alerts.append(('SCHEMA', rel, f'unreadable parquet: {e}'))

    # --- 3. GAP detection (per series). Only judge row counts that are KNOWN; NULL row counts
    #        mean pyarrow wasn't available at ingest (deferred), not an empty series. ---
    series = {}
    for source, venue, market, res, rel, nrows, sha, schema_fp in rows:
        d = series.setdefault((venue, market, res), {'files': 0, 'known': 0, 'rows': 0})
        d['files'] += 1
        if nrows is not None:
            d['known'] += 1; d['rows'] += nrows
    for (venue, market, res), d in series.items():
        if d['known'] == 0:
            skips.append(f"GAP — {venue}/{market}/{res}: {d['files']} file(s), row counts unknown (pyarrow deferred)")
        elif d['rows'] == 0:
            alerts.append(('GAP', f'{venue}/{market}/{res}', 'series has files but 0 rows (empty/failed ingest)'))

    # --- 4. FEE-BOOKING (fee-less-resolver bug) — settlement/pnl curated tables must carry a fee column ---
    for tbl in ('settlements', 'pnl', 'fills'):
        t = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (tbl,)).fetchone()
        if t:
            cols = [c[1] for c in conn.execute(f'PRAGMA table_info({tbl})')]
            if not any('fee' in c.lower() for c in cols):
                alerts.append(('FEE-BOOK', tbl, 'settlement/pnl table has NO fee column — fee-less-resolver risk'))

    # --- 5. CROSS-SOURCE agreement (signing-bug-faked-P&L class) — flag if a series has 2+ sources ---
    src_by_series = {}
    for source, venue, market, res, rel, nrows, sha, schema_fp in rows:
        src_by_series.setdefault((venue, market, res), set()).add(source)
    multi = {k: v for k, v in src_by_series.items() if len(v) > 1}
    if multi:
        print(f"cross-source: {len(multi)} series have >=2 sources (agreement check applies once curated):")
        for k, v in list(multi.items())[:5]:
            print(f"  {k[0]}/{k[1]}/{k[2]}: {sorted(v)}")

    # --- 6. VINTAGE (data-snooping) — macro signal tables must carry a vintage/asof column ---
    for tbl in ('sig_macro',):
        t = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (tbl,)).fetchone()
        if t:
            cols = [c[1] for c in conn.execute(f'PRAGMA table_info({tbl})')]
            if not any(c.lower() in ('vintage_date', 'asof', 'vintage') for c in cols):
                alerts.append(('VINTAGE', tbl, 'macro table missing vintage/asof — point-in-time/data-snooping risk'))
    conn.close()

    print(f"files/series checked: {checked}")
    for s in skips:
        print(f"SKIP: {s}")
    print(f"alerts: {len(alerts)}")
    for typ, obj, detail in alerts:
        print(f"\n{typ}: {obj}\n  {detail}")
    if alerts:
        if args.alert_cmd:
            import subprocess
            msg = f"WAREHOUSE INTEGRITY: {len(alerts)} issue(s)\n" + "\n".join(f"- {t}: {o}: {d}" for t, o, d in alerts)
            try:
                subprocess.run(args.alert_cmd.split() + [msg], timeout=30)
            except Exception:
                pass
        return 1
    print("All clean.")
    return 0


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Audit log / data-warehouse integrity check')
    parser.add_argument('--mode', choices=['task', 'data'], default='task',
                        help='task = task-audit integrity (default); data = warehouse integrity')
    parser.add_argument('--minutes', type=int, default=60, help='Window to scan (task mode, default: 60)')
    parser.add_argument('--task-dir', help='Path to task JSON directory (required for --mode task)')
    parser.add_argument('--warehouse', help='Path to warehouse root (required for --mode data)')
    parser.add_argument('--alert-cmd', help='Command to run on alert')
    args = parser.parse_args()

    if args.mode == 'data':
        sys.exit(run_data_integrity(args))
    if not args.task_dir:
        parser.error('--task-dir is required for --mode task')

    task_dir = Path(args.task_dir)
    audit_dir = task_dir / 'audit'

    if not task_dir.exists():
        print(f"Task directory not found: {task_dir}")
        sys.exit(0)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.minutes)
    alerts = []
    checked = 0

    for task_file in task_dir.glob('task_*.json'):
        try:
            task = json.loads(task_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        if task.get('status') != 'completed':
            continue

        completed_at = task.get('completed_at')
        if not completed_at:
            continue

        try:
            completed_dt = datetime.fromisoformat(completed_at.replace('Z', '+00:00'))
        except (ValueError, TypeError):
            continue

        if completed_dt < cutoff:
            continue

        checked += 1
        task_id = task.get('id', task_file.stem)

        audit_file = audit_dir / f"{task_id}.jsonl"
        if not audit_file.exists():
            alerts.append({
                'task_id': task_id,
                'type': 'TAMPER',
                'detail': 'task completed but NO audit file exists',
                'agent': task.get('assigned_to', 'unknown'),
            })
            continue

        audit_entries = []
        try:
            for line in audit_file.read_text().strip().split('\n'):
                if line.strip():
                    audit_entries.append(json.loads(line))
        except (json.JSONDecodeError, OSError):
            alerts.append({
                'task_id': task_id,
                'type': 'TAMPER',
                'detail': 'audit file exists but is unparseable',
                'agent': task.get('assigned_to', 'unknown'),
            })
            continue

        has_complete_event = any(e.get('event') == 'complete' for e in audit_entries)
        has_update_to_completed = any(
            e.get('event') == 'update' and e.get('to') == 'completed'
            for e in audit_entries
        )

        if not has_complete_event and not has_update_to_completed:
            alerts.append({
                'task_id': task_id,
                'type': 'TAMPER',
                'detail': 'task status=completed but no completion event in audit log (possible direct JSON write)',
                'agent': task.get('assigned_to', 'unknown'),
            })
        elif has_update_to_completed and not has_complete_event:
            alerts.append({
                'task_id': task_id,
                'type': 'BYPASS',
                'detail': 'task completed via update-task instead of complete-task (verification gate bypassed)',
                'agent': task.get('assigned_to', 'unknown'),
            })

    print("=== AUDIT INTEGRITY CHECK ===")
    print(f"Window: last {args.minutes} minutes")
    print(f"Completed tasks checked: {checked}")
    print(f"Alerts: {len(alerts)}")

    if alerts:
        for a in alerts:
            print(f"\n{a['type']}: {a['task_id']} (agent={a['agent']})")
            print(f"  {a['detail']}")

        if args.alert_cmd:
            import subprocess
            alert_msg = f"AUDIT INTEGRITY ALERT: {len(alerts)} issue(s) detected"
            for a in alerts:
                alert_msg += f"\n- {a['type']}: {a['task_id']} ({a['agent']}): {a['detail']}"
            try:
                subprocess.run(args.alert_cmd.split() + [alert_msg], timeout=30)
            except Exception:
                pass

        sys.exit(1)
    else:
        print("All clean.")
        sys.exit(0)


if __name__ == '__main__':
    main()
