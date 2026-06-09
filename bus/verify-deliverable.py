#!/usr/bin/env python3
"""cortextos-verify-deliverable — deterministic re-execution of [CITE:...] citations.

Extracts [CITE:type:artifact:evidence] citations from input,
re-executes each against reality, and reports PASS/FAIL.
Also checks ACCEPT: criteria for omission detection (Gate 1).

Exit codes: 0=all pass, 1=any fail, 2=no citations, 3=parse error
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

SHELL_METACHARACTERS = re.compile(r'[;|&`$><()\n\r]')

ALLOWED_BINARIES = {
    "python3": {"-m pytest"},
    "npm": {"test", "run lint"},
    "git": {"status", "log", "diff"},
    "ls": None,
    "stat": None,
    "wc": None,
    "grep": None,
    "cat": None,
    "head": None,
    "tail": None,
    "sha256sum": None,
    "shasum": None,
    "cortextos": {"bus"},
    "curl": {"-s -o /dev/null -w"},
    "pgrep": None,
    "ps": None,
    "printenv": None,
    "sqlite3": None,
}

CITE_PATTERN = re.compile(r'\[CITE:([^:\]]+):([^:\]]+):([^\]]*)\]')


def is_allowed_cmd(cmd: str) -> tuple[bool, str]:
    if SHELL_METACHARACTERS.search(cmd):
        return False, "REJECTED: shell metacharacters detected"

    try:
        argv = shlex.split(cmd)
    except ValueError as e:
        return False, f"REJECTED: unparseable command ({e})"

    if not argv:
        return False, "REJECTED: empty command"

    binary = os.path.basename(argv[0])

    if binary not in ALLOWED_BINARIES:
        return False, f"binary '{binary}' not in allowlist"

    subcmds = ALLOWED_BINARIES[binary]
    if subcmds is None:
        return True, ""

    rest = " ".join(argv[1:])
    for allowed_sub in subcmds:
        if rest.startswith(allowed_sub):
            return True, ""

    return False, f"subcommand not allowed for '{binary}': {rest}"


def verify_file(path: str, evidence: str) -> tuple[str, str]:
    if not os.path.exists(path):
        return "FAIL", f"file does not exist: {path}"

    try:
        st = os.stat(path)
        details = f"file exists ({st.st_size} bytes, mode={oct(st.st_mode)})"
    except OSError as e:
        return "FAIL", f"stat error: {e}"

    if "hash=" in evidence:
        m = re.search(r'hash=([a-f0-9]+)', evidence)
        if m:
            expected = m.group(1)
            actual = hashlib.sha256(open(path, 'rb').read()).hexdigest()
            if actual.startswith(expected):
                details += "; hash matches"
            else:
                return "FAIL", f"{details}; hash MISMATCH (expected={expected[:12]}... actual={actual[:12]}...)"

    if "contains=" in evidence:
        m = re.search(r"contains='([^']+)'", evidence)
        if m:
            search = m.group(1)
            content = open(path, 'r', errors='replace').read()
            if search in content:
                details += f"; contains '{search}'"
            else:
                return "FAIL", f"{details}; does NOT contain '{search}'"

    if "lines>=" in evidence:
        m = re.search(r'lines>=(\d+)', evidence)
        if m:
            min_lines = int(m.group(1))
            actual_lines = sum(1 for _ in open(path, 'r', errors='replace'))
            if actual_lines >= min_lines:
                details += f"; {actual_lines} lines (>= {min_lines})"
            else:
                return "FAIL", f"{details}; {actual_lines} lines (< {min_lines} required)"

    return "PASS", details


def verify_cmd(cmd: str, evidence: str, timeout: int) -> tuple[str, str]:
    allowed, reason = is_allowed_cmd(cmd)
    if not allowed:
        return "SKIP", f"command not in allowlist: {cmd} ({reason})"

    try:
        argv = shlex.split(cmd)
    except ValueError as e:
        return "SKIP", f"command parse error: {e}"

    try:
        result = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout
        )
        exit_code = result.returncode
        stdout = result.stdout
    except subprocess.TimeoutExpired:
        return "FAIL", f"command timed out after {timeout}s"
    except Exception as e:
        return "FAIL", f"command error: {e}"

    details = f"exit={exit_code}"
    ok = True

    if "exit=" in evidence:
        m = re.search(r'exit=(\d+)', evidence)
        if m:
            expected = int(m.group(1))
            if exit_code == expected:
                details += f" (expected {expected})"
            else:
                details += f" (expected {expected}, got {exit_code})"
                ok = False

    if "stdout_contains=" in evidence:
        m = re.search(r"stdout_contains='([^']+)'", evidence)
        if m:
            search = m.group(1)
            if search in stdout:
                details += f"; stdout contains '{search}'"
            else:
                details += f"; stdout does NOT contain '{search}'"
                ok = False

    return ("PASS" if ok else "FAIL"), details


def verify_proc(name: str, evidence: str) -> tuple[str, str]:
    if "running" in evidence:
        try:
            result = subprocess.run(
                ["pgrep", "-f", name], capture_output=True, text=True
            )
            if result.returncode == 0:
                pid = result.stdout.strip().split('\n')[0]
                return "PASS", f"running (pid={pid})"
            else:
                return "FAIL", "NOT running"
        except Exception as e:
            return "FAIL", f"pgrep error: {e}"

    return "SKIP", f"unsupported proc evidence: {evidence}"


def verify_db(db_path: str, evidence: str, timeout: int) -> tuple[str, str]:
    if not os.path.exists(db_path):
        return "FAIL", f"database file does not exist: {db_path}"

    m_query = re.search(r'query="([^"]+)"', evidence)
    m_result = re.search(r'result=([^,\]]+)', evidence)

    if not m_query:
        return "SKIP", "no query in evidence"

    query = m_query.group(1)
    expected = m_result.group(1) if m_result else None

    try:
        result = subprocess.run(
            ["sqlite3", db_path, query],
            capture_output=True, text=True, timeout=timeout
        )
        actual = result.stdout.strip()
    except Exception as e:
        return "FAIL", f"sqlite3 error: {e}"

    if expected is not None and actual == expected:
        return "PASS", f"query returned: {actual} (expected: {expected})"
    elif expected is not None:
        return "FAIL", f"query returned: {actual} (expected: {expected})"
    else:
        return "PASS", f"query returned: {actual}"


def verify_log(log_path: str, evidence: str) -> tuple[str, str]:
    if not os.path.exists(log_path):
        return "FAIL", f"log file does not exist: {log_path}"

    ok = True
    details = ""

    if "match=" in evidence:
        m = re.search(r'match="([^"]+)"', evidence)
        if m:
            pattern = m.group(1)
            content = open(log_path, 'r', errors='replace').read()
            if pattern in content:
                details = f"pattern '{pattern}' found"
            else:
                details = f"pattern '{pattern}' NOT found"
                ok = False

    return ("PASS" if ok else "FAIL"), details


def verify_env(var_name: str, evidence: str) -> tuple[str, str]:
    if "set" in evidence:
        if var_name in os.environ:
            return "PASS", f"{var_name} is set (value NOT logged for security)"
        else:
            return "FAIL", f"{var_name} is NOT set"
    return "SKIP", f"unsupported env evidence: {evidence}"


def extract_accept_criteria(desc: str) -> list[str]:
    criteria = []
    in_accept = False
    for line in desc.split('\n'):
        if 'ACCEPT:' in line:
            in_accept = True
            continue
        if in_accept:
            stripped = line.strip()
            if re.match(r'^- \[.\]', stripped):
                criterion = re.sub(r'^- \[.\] ', '', stripped)
                criteria.append(criterion)
            elif stripped and not stripped.startswith('-') and not stripped.startswith(' '):
                in_accept = False
    return criteria


def main():
    parser = argparse.ArgumentParser(description='Verify deliverable citations')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--task', help='Task ID to verify')
    group.add_argument('--file', help='File containing citations')
    group.add_argument('--stdin', action='store_true', help='Read from stdin')
    parser.add_argument('--desc', help='Task description (for Gate 1 ACCEPT: criteria extraction)')
    parser.add_argument('--strict', action='store_true')
    parser.add_argument('--timeout', type=int, default=30)
    parser.add_argument('--log', help='Write log to file')
    parser.add_argument('--json', action='store_true', dest='json_output')
    args = parser.parse_args()

    input_text = ""
    task_desc = ""
    source_label = ""

    if args.task:
        source_label = f"task ({args.task})"
        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            cli = os.path.join(script_dir, '..', 'dist', 'cli.js')
            result = subprocess.run(
                ['node', cli, 'bus', 'get-task', args.task, '--format', 'json'],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                data = json.loads(result.stdout)
                input_text = data.get('result', '')
                task_desc = data.get('description', '')
        except Exception:
            pass
    elif args.file:
        source_label = f"file ({args.file})"
        input_text = open(args.file, 'r').read()
    elif args.stdin:
        source_label = "stdin"
        input_text = sys.stdin.read()

    if args.desc:
        task_desc = args.desc

    if not input_text:
        print("ERROR: No input text found")
        sys.exit(2)

    # Extract citations
    citations = CITE_PATTERN.findall(input_text)

    # Gate 1: Acceptance criteria
    accept_criteria = extract_accept_criteria(task_desc) if task_desc else []
    accept_fail = 0
    accept_results = []

    if accept_criteria:
        for criterion in accept_criteria:
            cite_match = CITE_PATTERN.search(criterion)
            if cite_match:
                ctype, cartifact = cite_match.group(1), cite_match.group(2)
                found = any(
                    c[0] == ctype and c[1] == cartifact
                    for c in citations
                )
                if found:
                    accept_results.append(f"  COVERED: {criterion}")
                else:
                    accept_results.append(f"  MISSING: {criterion}")
                    accept_fail += 1
            else:
                accept_results.append(f"  UNCHECKED: {criterion} (no expected citation)")

    # Gate 2: Verify each citation
    total = len(citations)
    pass_count = 0
    fail_count = 0
    skip_count = 0
    results = []

    for i, (ctype, artifact, evidence) in enumerate(citations):
        idx = i + 1
        cite_str = f"[CITE:{ctype}:{artifact}:{evidence}]"

        if ctype == "file":
            status, detail = verify_file(artifact, evidence)
        elif ctype == "cmd":
            status, detail = verify_cmd(artifact, evidence, args.timeout)
        elif ctype == "proc":
            status, detail = verify_proc(artifact, evidence)
        elif ctype == "db":
            status, detail = verify_db(artifact, evidence, args.timeout)
        elif ctype == "log":
            status, detail = verify_log(artifact, evidence)
        elif ctype == "env":
            status, detail = verify_env(artifact, evidence)
        else:
            status = "FAIL" if args.strict else "SKIP"
            detail = f"unknown citation type: {ctype}"

        if status == "PASS":
            pass_count += 1
        elif status == "FAIL":
            fail_count += 1
        else:
            skip_count += 1

        results.append(f"[{idx}/{total}] {status}  {cite_str}")
        results.append(f"  {detail}")

    # Output
    lines = []
    lines.append("=== VERIFICATION REPORT ===")
    lines.append(f"Source: {source_label}")
    lines.append(f"Verified at: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    lines.append("")

    if accept_criteria:
        lines.append("--- GATE 1: Acceptance Criteria ---")
        lines.append(f"Criteria found: {len(accept_criteria)}")
        lines.append(f"Missing citations: {accept_fail}")
        lines.extend(accept_results)
        lines.append("")

    lines.append("--- GATE 2: Citation Verification ---")
    lines.append(f"Citations found: {total}")
    lines.extend(results)
    lines.append("")

    overall_fail = fail_count + accept_fail
    if overall_fail > 0:
        lines.append(f"VERDICT: FAIL ({pass_count} pass, {fail_count} citation fail, {accept_fail} criteria missing, {skip_count} skip)")
    elif total == 0 and not accept_criteria:
        lines.append("VERDICT: NO CITATIONS (nothing to verify)")
    else:
        lines.append(f"VERDICT: PASS ({pass_count} pass, {skip_count} skip)")

    output = '\n'.join(lines)

    if args.log:
        with open(args.log, 'w') as f:
            f.write(output + '\n')
    print(output)

    if overall_fail > 0:
        sys.exit(1)
    elif total == 0 and not accept_criteria:
        sys.exit(2)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
