#!/usr/bin/env python3
"""Validate a structured handoff JSON document.

Usage:
    python3 validate-handoff.py <handoff.json>

Exits 0 when the handoff is valid, nonzero otherwise. All validation errors
are written to stderr, one per line.

Contract: orgs/main/agents/forge/tasks/task_1781233336832_72619193/validation-contract.md
Template: templates/handoff.json

Rules:
- The document must be a JSON object.
- Required fields: task_id, from, to, objective, inputs, expected_artifacts,
  validation_contract, deadline, model_tier.
- String fields must be non-empty (after stripping whitespace).
- inputs / expected_artifacts must be arrays of non-empty strings.
- deadline must be an ISO-8601 timestamp with an explicit timezone offset
  (e.g. 2026-06-13T03:15:00Z).
- model_tier must be one of the fleet tiers: sonnet, opus, fable, codex
  (haiku is excluded per B-locked fleet tiering, 2026-06-12).

Stdlib only. Authored by a bounded claude-fable-5 worker.
"""

import json
import sys
from datetime import datetime

EXIT_OK = 0
EXIT_INVALID = 1
EXIT_USAGE = 2

REQUIRED_FIELDS = (
    "task_id",
    "from",
    "to",
    "objective",
    "inputs",
    "expected_artifacts",
    "validation_contract",
    "deadline",
    "model_tier",
)
STRING_FIELDS = ("task_id", "from", "to", "objective", "validation_contract")
PATH_ARRAY_FIELDS = ("inputs", "expected_artifacts")
VALID_MODEL_TIERS = frozenset({"sonnet", "opus", "fable", "codex"})


def _is_nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""


def _is_valid_deadline(value):
    if not isinstance(value, str):
        return False
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return False
    # Require an explicit timezone so deadlines are unambiguous across agents.
    return parsed.tzinfo is not None


def validate_handoff(data):
    """Return a list of validation error strings (empty when valid)."""
    if not isinstance(data, dict):
        return ["top-level document must be a JSON object"]

    errors = []
    for field in REQUIRED_FIELDS:
        if field not in data:
            errors.append(f"missing required field: {field}")
    if errors:
        return errors

    for field in STRING_FIELDS:
        if not _is_nonempty_string(data[field]):
            errors.append(f"field {field} must be a non-empty string")

    for field in PATH_ARRAY_FIELDS:
        value = data[field]
        if not isinstance(value, list):
            errors.append(f"field {field} must be an array of paths")
        elif not all(_is_nonempty_string(item) for item in value):
            errors.append(f"field {field} must contain only non-empty strings")

    if not _is_valid_deadline(data["deadline"]):
        errors.append(
            "field deadline must be an ISO-8601 timestamp with a timezone "
            "(e.g. 2026-06-13T03:15:00Z)"
        )

    tier = data["model_tier"]
    if not isinstance(tier, str) or tier not in VALID_MODEL_TIERS:
        errors.append(
            f"field model_tier must be one of {sorted(VALID_MODEL_TIERS)}, "
            f"got: {tier!r}"
        )

    return errors


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <handoff.json>", file=sys.stderr)
        return EXIT_USAGE

    path = argv[1]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
        return EXIT_INVALID
    except json.JSONDecodeError as exc:
        print(f"invalid JSON in {path}: {exc}", file=sys.stderr)
        return EXIT_INVALID

    errors = validate_handoff(data)
    if errors:
        for error in errors:
            print(f"{path}: {error}", file=sys.stderr)
        return EXIT_INVALID

    print(f"OK: {path} is a valid handoff")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv))
