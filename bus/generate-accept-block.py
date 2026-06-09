#!/usr/bin/env python3
"""generate-accept-block.py — Generate ACCEPT: blocks for task descriptions.

Takes a task description and generates acceptance criteria with expected
[CITE:type:artifact:evidence] entries. Used by the orchestrator at dispatch
time to arm Gate 1 (omission detection).

Usage:
  generate-accept-block.py --title "Fix auth bug" --deliverables "auth.py tests"
  generate-accept-block.py --title "Build feature X" --deliverables "src/feature.py tests/ docs/"

Outputs an ACCEPT: block to append to the task description.
"""
import argparse
import sys


def generate_accept_block(title: str, deliverables: list[str], require_tests: bool = True, require_commit: bool = True) -> str:
    lines = ["\nACCEPT:"]

    for d in deliverables:
        d = d.strip()
        if not d:
            continue

        if d.endswith('.py') or d.endswith('.ts') or d.endswith('.js') or d.endswith('.sh'):
            lines.append(f"- [ ] {d} exists and is non-empty [CITE:file:{d}:exists,lines>=1]")
        elif d.endswith('/'):
            lines.append(f"- [ ] {d} directory has deliverables [CITE:cmd:ls {d}:exit=0]")
        else:
            lines.append(f"- [ ] {d} delivered [CITE:file:{d}:exists]")

    if require_tests:
        lines.append("- [ ] Tests pass [CITE:cmd:npm test:exit=0]")

    if require_commit:
        lines.append("- [ ] Changes committed [CITE:cmd:git status:exit=0]")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description='Generate ACCEPT: block for task descriptions')
    parser.add_argument('--title', required=True, help='Task title')
    parser.add_argument('--deliverables', nargs='+', default=[], help='Expected deliverable paths')
    parser.add_argument('--no-tests', action='store_true', help='Skip test requirement')
    parser.add_argument('--no-commit', action='store_true', help='Skip commit requirement')
    parser.add_argument('--custom', nargs='+', default=[], help='Custom acceptance criteria (format: "description|CITE:type:artifact:evidence")')
    args = parser.parse_args()

    block = generate_accept_block(
        args.title,
        args.deliverables,
        require_tests=not args.no_tests,
        require_commit=not args.no_commit,
    )

    for custom in args.custom:
        if '|' in custom:
            desc, cite = custom.split('|', 1)
            block += f"\n- [ ] {desc.strip()} [{cite.strip()}]"
        else:
            block += f"\n- [ ] {custom}"

    print(block)


if __name__ == '__main__':
    main()
