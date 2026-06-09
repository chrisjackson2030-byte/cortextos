#!/usr/bin/env python3
"""agent-audit-kit — agent-specific security scanner (cortextos-vet Layer 4).

Scans a downloaded package for risks that generic CVE/malware/static scanners
(Layers 1/2/3) miss — risks specific to running code inside an autonomous agent:

  1. prompt-injection / instruction-override   (text that tries to override agent behavior)
  2. tool/shell-execution abuse                 (eval/exec/os.system/subprocess on input)
  3. data-exfiltration                          (network POST/exfil of env/secret reads)
  4. credential/secret access                   (Keychain, .env, API-key, token reads)
  5. autonomous-action / self-modification      (writes outside scope, self-config edits)

Output: JSON {findings: [{rule, category, severity, file, line, snippet, message}],
summary} on stdout, so bus/cortextos-vet.sh Layer 4 parses it like Layers 2/3/5.

Stdlib only (no runtime deps — matches the project rule). Python files are parsed
with `ast` where possible (precise) and all text files are regex-scanned (broad,
catches docs/prompts/JS/configs). Findings carry file:line + severity.

Usage:
  agent-audit-kit scan <path> [--json] [--min-severity low|medium|high|critical]
  exit 0 = no findings at/above min-severity; 1 = findings; 2 = bad usage
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# File extensions worth scanning. Code + text/docs/prompts/configs (injection lives in text).
_CODE_EXT = {".py", ".js", ".ts", ".jsx", ".tsx", ".sh", ".bash"}
_TEXT_EXT = {".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".env"}
_SCAN_EXT = _CODE_EXT | _TEXT_EXT
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".tox"}
_MAX_BYTES = 2_000_000  # skip files larger than 2MB (vendored blobs)


@dataclass
class Finding:
    rule: str
    category: str
    severity: str
    file: str
    line: int
    snippet: str
    message: str


# ── regex rules (broad — run over every text/code file) ─────────────────────
# Each: (rule_id, category, severity, compiled_regex, message)
_REGEX_RULES = [
    # 1. prompt-injection / instruction-override
    ("prompt_injection_override", "prompt_injection", "high",
     re.compile(r"(?i)\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,40}\b(instruction|prompt|rule|directive|command)s?\b"),
     "instruction-override phrase ('ignore previous instructions'-style) — prompt-injection risk"),
    ("prompt_injection_system_override", "prompt_injection", "high",
     re.compile(r"(?i)\byou are now\b|\bnew (system )?(prompt|instruction|role)\b|\bsystem[- ]level (directive|override)\b|\bdeveloper mode\b"),
     "attempts to redefine the agent's system role/prompt — prompt-injection risk"),
    ("prompt_injection_silent", "prompt_injection", "critical",
     re.compile(r"(?i)\b(do not|don'?t|never)\b.{0,30}\b(tell|inform|mention|report|notify)\b.{0,30}\b(user|operator|orchestrator|admin|anyone)\b"),
     "instructs the agent to hide actions from its operator — covert prompt-injection"),
    # 3. data-exfiltration (regex layer; AST layer adds precision)
    ("exfil_env_to_network", "data_exfiltration", "critical",
     re.compile(r"(?i)(requests?\.(post|put|get)|urllib|fetch|curl|httpx|axios)\b.{0,80}(os\.environ|getenv|process\.env|api[_-]?key|secret|token|password)"),
     "network call referencing env/secret values — possible credential exfiltration"),
    ("exfil_suspicious_host", "data_exfiltration", "high",
     re.compile(r"(?i)https?://[a-z0-9.-]*\b(telemetry|exfil|collect|beacon|webhook\.site|pastebin|ngrok|requestbin)\b[a-z0-9./-]*"),
     "hardcoded URL to a known exfil/telemetry/paste endpoint"),
    # 4. credential / secret access
    ("cred_keychain_access", "credential_access", "high",
     re.compile(r"(?i)\b(security find-generic-password|keychain|get_secret|getpass\.getpass|keyring\.get_password)\b"),
     "reads credentials from Keychain/secret store"),
    ("cred_dotenv_read", "credential_access", "medium",
     re.compile(r"(?i)(open|read|load)\w*\(.{0,40}\.env\b|dotenv|load_dotenv"),
     "reads a .env / dotenv secrets file"),
    ("cred_aws_creds", "credential_access", "high",
     re.compile(r"(?i)\.aws/credentials|AWS_SECRET_ACCESS_KEY|aws_secret_access_key"),
     "reads AWS credential material"),
    ("cred_env_secret_read", "credential_access", "medium",
     # No \b before the secret word: env var names like FINNHUB_API_KEY have no word
     # boundary before "API" (underscore→letter isn't a boundary). The os.environ
     # anchor + proximity is specific enough.
     re.compile(r"(?i)(os\.environ|getenv|process\.env)\b.{0,30}(api[_-]?key|secret|token|password|passwd|credential)"),
     "reads a secret-named value from the environment (api_key/secret/token/password)"),
    # 5. autonomous-action / self-modification
    ("self_mod_config", "self_modification", "high",
     re.compile(r"(?i)(open|write|edit|patch)\w*\(.{0,60}(CLAUDE\.md|SOUL\.md|GUARDRAILS\.md|settings\.json|crontab|\.bashrc|\.zshrc|authorized_keys)"),
     "writes to agent identity/config/shell-init files — self-modification risk"),
    ("autonomous_crontab", "self_modification", "medium",
     re.compile(r"(?i)\bcrontab\b|launchctl (load|bootstrap)|systemctl (enable|start)|schtasks"),
     "installs a persistent scheduled task — autonomous-persistence risk"),
]


def iter_files(root: Path):
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in _SCAN_EXT and p.name != ".env":
            continue
        try:
            if p.stat().st_size > _MAX_BYTES:
                continue
        except OSError:
            continue
        yield p


def _rel(p: Path, root: Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def scan_text(p: Path, root: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    lines = text.splitlines()
    for rule_id, category, severity, rx, message in _REGEX_RULES:
        for m in rx.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            snippet = (lines[line_no - 1].strip()[:160] if 0 < line_no <= len(lines) else m.group(0)[:160])
            findings.append(Finding(rule_id, category, severity, _rel(p, root), line_no, snippet, message))
    return findings


# ── AST rules (Python only — precise: exec/eval/subprocess on non-literal input) ──

_SHELL_CALLS = {
    ("os", "system"), ("os", "popen"), ("subprocess", "call"), ("subprocess", "run"),
    ("subprocess", "Popen"), ("subprocess", "check_output"), ("subprocess", "check_call"),
}
_EVAL_NAMES = {"eval", "exec", "compile"}


def _is_literal(node: ast.AST) -> bool:
    """True if the arg is a pure constant/literal (safe-ish); False if it involves
    a name/call/fstring/concat (potentially attacker-influenced input)."""
    return isinstance(node, ast.Constant) or (
        isinstance(node, (ast.List, ast.Tuple))
        and all(_is_literal(e) for e in node.elts)
    )


def scan_python_ast(p: Path, root: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return findings  # regex layer still covers it

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        ln = getattr(node, "lineno", 0)
        # eval / exec / compile. CRITICAL on non-literal input (arbitrary code exec);
        # a pure-literal exec/eval is informational LOW (won't fail the medium gate) —
        # e.g. six.py:740 exec("""def reraise...""") is a fixed py2/3 compat string, not
        # a risk. Same principle as the literal-subprocess case (no gate-fail on benign).
        if isinstance(node.func, ast.Name) and node.func.id in _EVAL_NAMES:
            non_literal = bool(node.args) and not _is_literal(node.args[0])
            sev = "critical" if non_literal else "low"
            msg = (f"{node.func.id}() on non-literal input — arbitrary code execution"
                   if non_literal else f"{node.func.id}() on a literal — review (informational)")
            findings.append(Finding("exec_eval_call", "shell_execution", sev,
                                    _rel(p, root), ln, f"{node.func.id}(...)", msg))
        # os.system / subprocess.* with shell=True or non-literal command
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            pair = (node.func.value.id, node.func.attr)
            if pair in _SHELL_CALLS:
                shell_true = any(
                    isinstance(kw.value, ast.Constant) and kw.value.value is True
                    for kw in node.keywords if kw.arg == "shell"
                )
                non_literal = bool(node.args) and not _is_literal(node.args[0])
                if shell_true and non_literal:
                    sev, why = "critical", "shell=True with non-literal command — command injection"
                elif shell_true:
                    sev, why = "high", "subprocess with shell=True — injection-prone"
                elif non_literal:
                    sev, why = "high", "shell/subprocess on non-literal input — review for injection"
                else:
                    sev, why = "low", "shell/subprocess call — review"
                findings.append(Finding("shell_exec_call", "shell_execution", sev,
                                        _rel(p, root), ln, f"{pair[0]}.{pair[1]}(...)", why))
    return findings


def scan_path(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for p in iter_files(root):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        findings.extend(scan_text(p, root, text))
        if p.suffix.lower() == ".py":
            findings.extend(scan_python_ast(p, root, text))
    return findings


def _max_severity(findings: list[Finding]) -> str | None:
    if not findings:
        return None
    return max(findings, key=lambda f: SEVERITY_ORDER[f.severity]).severity


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-audit-kit")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("scan", help="scan a package directory for agent-specific risks")
    sp.add_argument("path")
    sp.add_argument("--json", action="store_true", help="emit JSON (default human)")
    sp.add_argument("--min-severity", default="low", choices=list(SEVERITY_ORDER))
    args = parser.parse_args(argv)

    root = Path(args.path)
    if not root.exists():
        print(json.dumps({"error": f"path not found: {root}"}) if args.json
              else f"error: path not found: {root}", file=sys.stderr)
        return 2

    threshold = SEVERITY_ORDER[args.min_severity]
    all_findings = scan_path(root)
    findings = [f for f in all_findings if SEVERITY_ORDER[f.severity] >= threshold]
    by_cat: dict[str, int] = {}
    by_sev: dict[str, int] = {}
    for f in findings:
        by_cat[f.category] = by_cat.get(f.category, 0) + 1
        by_sev[f.severity] = by_sev.get(f.severity, 0) + 1

    report = {
        "tool": "agent-audit-kit",
        "path": str(root),
        "summary": {
            "total_findings": len(findings),
            "by_severity": by_sev,
            "by_category": by_cat,
            "max_severity": _max_severity(findings),
        },
        "findings": [asdict(f) for f in findings],
    }

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"agent-audit-kit scan: {root}")
        if not findings:
            print("  no agent-specific risks found at/above severity "
                  f"'{args.min_severity}'")
        else:
            for f in findings:
                print(f"  [{f.severity.upper():8}] {f.category}: {f.file}:{f.line} — {f.message}")
                print(f"             {f.snippet}")
            print(f"  TOTAL: {len(findings)} finding(s); max severity "
                  f"{report['summary']['max_severity']}")

    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
