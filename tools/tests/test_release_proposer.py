#!/usr/bin/env python3
"""Test (a): the proposer ONLY proposes, never applies; and cannot down-classify danger."""
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))
import release_proposer as rp  # noqa: E402


def _run_dry(argv):
    """Run the proposer in --dry-run and capture the printed proposal JSON."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = rp.main(argv + ["--dry-run"])
    return rc, json.loads(buf.getvalue())


class TestReleaseProposer(unittest.TestCase):
    def test_no_apply_or_promote_cli_surface(self):
        # The proposer must register no apply/promote/live argparse flag. We assert
        # against the actual registered option strings, not the source text (the
        # docstring legitimately mentions "no --apply"). Guards against a future
        # edit silently adding a promotion path.
        parser = None
        # Reconstruct main()'s parser by parsing a minimal valid invocation and
        # capturing the registered options via a probe.
        import argparse as _ap

        registered = []
        real_add = _ap.ArgumentParser.add_argument

        def spy_add(self, *a, **k):
            registered.extend([x for x in a if isinstance(x, str) and x.startswith("--")])
            return real_add(self, *a, **k)

        _ap.ArgumentParser.add_argument = spy_add
        try:
            try:
                rp.main(["--change-id", "x", "--summary", "y", "--dry-run", "--path", "docs/a.md"])
            except SystemExit:
                pass
        finally:
            _ap.ArgumentParser.add_argument = real_add

        for forbidden in ["--apply", "--promote", "--live", "--deploy"]:
            self.assertNotIn(forbidden, registered, f"proposer must not register {forbidden}")

    def test_proposal_is_proposed_only(self):
        rc, prop = _run_dry([
            "--change-id", "docs-refresh",
            "--summary", "refresh docs",
            "--category", "nightly-safe-update",
            "--path", "README.md",
        ])
        self.assertEqual(rc, 0)
        self.assertEqual(prop["status"], "PROPOSED")
        self.assertFalse(prop["promotion"]["auto_promote"])
        self.assertFalse(prop["promotion"]["promoted"])
        self.assertFalse(prop["human_approved"])

    def test_protected_path_auto_escalates_to_human_approval(self):
        # Caller requests nightly-safe-update but touches feature-flags -> human-approval.
        rc, prop = _run_dry([
            "--change-id", "flip-flag",
            "--summary", "enable a flag",
            "--category", "nightly-safe-update",
            "--path", "orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json",
            "--behavior-change",
        ])
        self.assertEqual(rc, 0)
        self.assertEqual(prop["category"], "human-approval")
        self.assertEqual(prop["requested_category"], "nightly-safe-update")
        self.assertTrue(prop["gates_required"]["human_approval"])
        self.assertIn("feature-flags", prop["protected_classes_touched"])
        # Still proposal-only, still not approved.
        self.assertEqual(prop["status"], "PROPOSED")
        self.assertFalse(prop["human_approved"])

    def test_behavior_change_escalates_to_weekly(self):
        rc, prop = _run_dry([
            "--change-id", "tweak-logic",
            "--summary", "change a code path",
            "--category", "nightly-safe-update",
            "--path", "src/daemon/worker.ts",
            "--behavior-change",
        ])
        self.assertEqual(prop["category"], "weekly-behavior-release")
        self.assertTrue(prop["gates_required"]["independent_reviewer"])
        self.assertTrue(prop["gates_required"]["canary_before_promotion"])

    def test_credentials_path_escalates(self):
        rc, prop = _run_dry([
            "--change-id", "rotate-cred",
            "--summary", "touch a secret",
            "--category", "nightly-safe-update",
            "--path", "orgs/main/agents/jarvis/.env",
        ])
        self.assertEqual(prop["category"], "human-approval")
        self.assertIn("credentials", prop["protected_classes_touched"])

    def test_always_required_gates_present(self):
        rc, prop = _run_dry([
            "--change-id", "x", "--summary", "y",
            "--category", "nightly-safe-update", "--path", "docs/a.md",
        ])
        g = prop["gates_required"]
        for must in ["eval_test_gate", "rollback_command_present",
                     "release_notes_written", "change_impact_report"]:
            self.assertTrue(g[must], must)

    def test_dry_run_writes_nothing(self):
        before = set(p.name for p in (REPO_ROOT / "releases" / "proposals").glob("*.json"))
        _run_dry(["--change-id", "ephemeral-test", "--summary", "z",
                  "--path", "docs/x.md"])
        after = set(p.name for p in (REPO_ROOT / "releases" / "proposals").glob("*.json"))
        self.assertEqual(before, after, "dry-run must not write a proposal file")


if __name__ == "__main__":
    unittest.main(verbosity=2)
