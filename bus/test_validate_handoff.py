"""Tests for bus/validate-handoff.py — structured-handoff validator.

Contract: orgs/main/agents/forge/tasks/task_1781233336832_72619193/validation-contract.md

The validator is exercised through its CLI (subprocess) because the contract's
binary pass criteria are expressed in exit codes: 0 for a valid handoff,
nonzero for anything malformed.

Authored by a bounded claude-fable-5 worker.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

BUS_DIR = Path(__file__).resolve().parent
REPO_ROOT = BUS_DIR.parent
VALIDATOR = BUS_DIR / "validate-handoff.py"
TEMPLATE_HANDOFF = REPO_ROOT / "templates" / "handoff.json"
DEMO_HANDOFF = (
    REPO_ROOT
    / "orgs/main/agents/forge/tasks/task_1781233336832_72619193/handoff.json"
)

REQUIRED_FIELDS = [
    "task_id",
    "from",
    "to",
    "objective",
    "inputs",
    "expected_artifacts",
    "validation_contract",
    "deadline",
    "model_tier",
]


def valid_handoff():
    """A minimal synthetic handoff that must pass validation."""
    return {
        "task_id": "task_test_001",
        "from": "jarvis",
        "to": "forge",
        "objective": "Test the handoff validator.",
        "inputs": ["/tmp/input.md"],
        "expected_artifacts": ["/tmp/output.md"],
        "validation_contract": "/tmp/validation-contract.md",
        "deadline": "2026-06-13T03:15:00Z",
        "model_tier": "sonnet",
    }


def write_handoff(tmp_path, data):
    path = tmp_path / "handoff.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def run_validator(*args):
    return subprocess.run(
        [sys.executable, str(VALIDATOR), *[str(a) for a in args]],
        capture_output=True,
        text=True,
    )


# --- existence / real deliverables -----------------------------------------


def test_validator_file_exists():
    assert VALIDATOR.is_file(), f"validator missing at {VALIDATOR}"


def test_template_handoff_is_valid():
    assert TEMPLATE_HANDOFF.is_file()
    result = run_validator(TEMPLATE_HANDOFF)
    assert result.returncode == 0, result.stderr


def test_demo_handoff_is_valid():
    assert DEMO_HANDOFF.is_file()
    result = run_validator(DEMO_HANDOFF)
    assert result.returncode == 0, result.stderr


# --- valid handoffs ---------------------------------------------------------


def test_valid_synthetic_handoff_passes(tmp_path):
    result = run_validator(write_handoff(tmp_path, valid_handoff()))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("tier", ["sonnet", "opus", "fable", "codex"])
def test_valid_model_tiers_accepted(tmp_path, tier):
    data = valid_handoff()
    data["model_tier"] = tier
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "deadline",
    ["2026-06-13T03:15:00Z", "2026-06-13T03:15:00+00:00", "2026-06-12T23:15:00-04:00"],
)
def test_valid_deadlines_accepted(tmp_path, deadline):
    data = valid_handoff()
    data["deadline"] = deadline
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode == 0, result.stderr


def test_empty_path_arrays_accepted(tmp_path):
    # A handoff with no inputs is unusual but structurally valid; the contract
    # only requires that the path fields be arrays.
    data = valid_handoff()
    data["inputs"] = []
    data["expected_artifacts"] = []
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode == 0, result.stderr


def test_unknown_extra_fields_accepted(tmp_path):
    data = valid_handoff()
    data["notes"] = "forward-compatible extension field"
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode == 0, result.stderr


# --- missing required fields ------------------------------------------------


@pytest.mark.parametrize("field", REQUIRED_FIELDS)
def test_missing_required_field_rejected(tmp_path, field):
    data = valid_handoff()
    del data[field]
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert field in result.stderr


# --- invalid model tiers ----------------------------------------------------


@pytest.mark.parametrize(
    "tier",
    ["haiku", "gpt-4o", "Sonnet", "FABLE", "", "  ", 5, None, ["sonnet"]],
)
def test_invalid_model_tier_rejected(tmp_path, tier):
    data = valid_handoff()
    data["model_tier"] = tier
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert "model_tier" in result.stderr


# --- invalid deadlines --------------------------------------------------------


@pytest.mark.parametrize(
    "deadline",
    [
        "tomorrow",
        "2026-13-45T99:99:99Z",
        "2026-06-13T03:15:00",  # naive: no timezone
        "2026-06-13",  # date only, no time or timezone
        "",
        1781233336832,
        None,
    ],
)
def test_invalid_deadline_rejected(tmp_path, deadline):
    data = valid_handoff()
    data["deadline"] = deadline
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert "deadline" in result.stderr


# --- non-array / malformed path fields ---------------------------------------


@pytest.mark.parametrize("field", ["inputs", "expected_artifacts"])
@pytest.mark.parametrize("bad_value", ["/single/path", {"path": "/x"}, 42, None])
def test_non_array_path_field_rejected(tmp_path, field, bad_value):
    data = valid_handoff()
    data[field] = bad_value
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert field in result.stderr


@pytest.mark.parametrize("field", ["inputs", "expected_artifacts"])
@pytest.mark.parametrize("bad_element", [123, None, ["nested"], {"path": "/x"}, ""])
def test_non_string_path_array_element_rejected(tmp_path, field, bad_element):
    data = valid_handoff()
    data[field] = ["/ok/path", bad_element]
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert field in result.stderr


# --- malformed string fields --------------------------------------------------


@pytest.mark.parametrize(
    "field", ["task_id", "from", "to", "objective", "validation_contract"]
)
@pytest.mark.parametrize("bad_value", ["", "   ", 7, None, ["x"]])
def test_malformed_string_field_rejected(tmp_path, field, bad_value):
    data = valid_handoff()
    data[field] = bad_value
    result = run_validator(write_handoff(tmp_path, data))
    assert result.returncode != 0
    assert field in result.stderr


# --- malformed documents / CLI misuse -----------------------------------------


@pytest.mark.parametrize("doc", [[], "just a string", 42, None])
def test_non_object_top_level_rejected(tmp_path, doc):
    result = run_validator(write_handoff(tmp_path, doc))
    assert result.returncode != 0


def test_invalid_json_rejected(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{not valid json", encoding="utf-8")
    result = run_validator(path)
    assert result.returncode != 0


def test_missing_file_rejected(tmp_path):
    result = run_validator(tmp_path / "does-not-exist.json")
    assert result.returncode != 0


def test_no_arguments_is_usage_error():
    result = run_validator()
    assert result.returncode != 0
