#!/usr/bin/env python3
"""Test (c): the checklist/record format validates."""
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

REQUIRED_RECORD_KEYS = {
    "release_id", "title", "category", "created_at", "created_by", "status",
    "what_changed", "why", "tests", "reviewer", "canary",
    "change_impact_report_ref", "rollback_command", "rollback_demonstrated",
    "release_notes", "human_approved", "promotion",
}
VALID_CATEGORIES = {"nightly-safe-update", "weekly-behavior-release", "human-approval"}


def _load(p):
    return json.loads((REPO_ROOT / p).read_text())


class TestRecordFormat(unittest.TestCase):
    def test_template_exists_and_has_required_keys(self):
        tmpl = _load("releases/RELEASE-RECORD-TEMPLATE.json")
        missing = REQUIRED_RECORD_KEYS - set(tmpl.keys())
        self.assertEqual(missing, set(), f"template missing keys: {missing}")

    def test_template_promotion_block_present(self):
        tmpl = _load("releases/RELEASE-RECORD-TEMPLATE.json")
        for k in ["auto_promote", "promoted", "promoted_by", "promoted_at"]:
            self.assertIn(k, tmpl["promotion"], k)
        self.assertFalse(tmpl["promotion"]["auto_promote"])

    def test_example_record_validates(self):
        rec = _load("releases/records/release-system-framework-2026-06-21.json")
        missing = REQUIRED_RECORD_KEYS - set(rec.keys())
        self.assertEqual(missing, set(), f"example record missing keys: {missing}")
        self.assertIn(rec["category"], VALID_CATEGORIES)
        # No auto-promotion in the example.
        self.assertFalse(rec["promotion"]["auto_promote"])
        self.assertFalse(rec["promotion"]["promoted"])
        # Rollback must be concrete (non-empty, not the template placeholder).
        self.assertTrue(rec["rollback_command"].strip())
        self.assertNotIn("<", rec["rollback_command"][:1])
        # change-impact report it references must exist.
        ref = REPO_ROOT / rec["change_impact_report_ref"]
        self.assertTrue(ref.exists(), f"referenced change-impact report missing: {ref}")

    def test_change_impact_report_has_rules_keys(self):
        ci = _load("system-model/change-impact/release-system-framework-2026-06-21.json")
        for k in ["change_id", "summary", "tests", "rollback",
                  "duplicate_capability_check", "credentials_and_permissions",
                  "revenue_or_trading_impact"]:
            self.assertIn(k, ci, k)

    def test_checklist_exists(self):
        chk = REPO_ROOT / "releases" / "RELEASE-CHECKLIST.md"
        self.assertTrue(chk.exists())
        text = chk.read_text().lower()
        for gate in ["change-impact", "reviewer", "canary", "rollback", "release notes"]:
            self.assertIn(gate, text, gate)

    def test_no_em_dashes_in_release_docs(self):
        # House rule: no em-dashes in framework docs.
        for p in ["releases/RELEASE-CHECKLIST.md", "releases/PROPOSAL-WORKFLOW.md"]:
            text = (REPO_ROOT / p).read_text()
            self.assertNotIn("—", text, f"em-dash found in {p}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
