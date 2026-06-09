#!/usr/bin/env python3
"""reverify-completed.py — Layer 2 defense-in-depth.

Scans all tasks completed in the last N minutes, re-runs verify-deliverable
on each task's result text, and reports any failures. Catches bypasses that
skip the complete-task CLI guard (update-task, direct JSON writes).

Exit codes: 0=all pass or no tasks, 1=any fail
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
VERIFIER = SCRIPT_DIR / 'verify-deliverable.py'

CITE_PATTERN_STR = r'\[CITE:[^\]]+\]'

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Re-verify recently completed tasks')
    parser.add_argument('--minutes', type=int, default=60, help='Window to scan (default: 60)')
    parser.add_argument('--task-dir', required=True, help='Path to task JSON directory')
    parser.add_argument('--alert-cmd', help='Command to run on failure (e.g., send-telegram)')
    parser.add_argument('--revert', action='store_true', help='Revert failed tasks to in_progress')
    args = parser.parse_args()

    task_dir = Path(args.task_dir)
    if not task_dir.exists():
        print(f"Task directory not found: {task_dir}")
        sys.exit(0)

    if not VERIFIER.exists():
        print(f"Verifier not found: {VERIFIER}")
        sys.exit(0)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.minutes)
    failures = []
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

        result = task.get('result', '')
        description = task.get('description', '')
        if not result:
            continue

        import re
        has_citations = bool(re.search(CITE_PATTERN_STR, result))
        has_accept = 'ACCEPT:' in description
        if not has_citations and not has_accept:
            continue

        checked += 1
        cmd = ['python3', str(VERIFIER), '--stdin', '--timeout', '15']
        if description:
            cmd.extend(['--desc', description])
        proc = subprocess.run(
            cmd, input=result, capture_output=True, text=True, timeout=60
        )

        if proc.returncode != 0:
            task_id = task.get('id', task_file.stem)
            priority = task.get('priority', 'unknown')
            assigned_to = task.get('assigned_to', 'unknown')
            verdict_line = ''
            for line in (proc.stdout or '').split('\n'):
                if line.startswith('VERDICT:'):
                    verdict_line = line
                    break

            failures.append({
                'task_id': task_id,
                'priority': priority,
                'assigned_to': assigned_to,
                'verdict': verdict_line,
                'file': str(task_file),
            })

            if args.revert:
                task['status'] = 'in_progress'
                task['completed_at'] = None
                task['updated_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
                task_file.write_text(json.dumps(task, indent=2))

    print(f"=== RE-VERIFY SCAN ===")
    print(f"Window: last {args.minutes} minutes (since {cutoff.strftime('%H:%M:%SZ')})")
    print(f"Tasks with citations checked: {checked}")
    print(f"Failures: {len(failures)}")

    if failures:
        for f in failures:
            print(f"\nFAIL: {f['task_id']} (agent={f['assigned_to']}, priority={f['priority']})")
            print(f"  {f['verdict']}")
            if args.revert:
                print(f"  REVERTED to in_progress")

        if args.alert_cmd:
            alert_msg = f"REVERIFY ALERT: {len(failures)} task(s) failed re-verification"
            for f in failures:
                alert_msg += f"\n- {f['task_id']} ({f['assigned_to']}): {f['verdict']}"
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
