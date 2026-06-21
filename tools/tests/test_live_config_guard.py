#!/usr/bin/env python3
"""Test (b): the live-config guard flags a protected-path write."""
import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))
import live_config_guard as guard  # noqa: E402


class TestLiveConfigGuard(unittest.TestCase):
    def setUp(self):
        # Ensure no stray authorization token leaks in from the environment.
        os.environ.pop("RELEASE_FLOW_AUTHORIZED", None)

    def test_feature_flags_is_blocked(self):
        r = guard.check("orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json")
        self.assertEqual(r["decision"], "BLOCK")
        self.assertEqual(r["protected_class"], "feature-flags")

    def test_agent_config_crons_is_blocked(self):
        r = guard.check("orgs/main/agents/jarvis/config.json")
        self.assertEqual(r["decision"], "BLOCK")
        self.assertEqual(r["protected_class"], "live-crons")

    def test_credentials_blocked(self):
        for p in ["orgs/main/agents/jarvis/.env", "secrets.json", "foo/api.key", "x/server.pem"]:
            r = guard.check(p)
            self.assertEqual(r["decision"], "BLOCK", p)
            self.assertEqual(r["protected_class"], "credentials", p)

    def test_live_prompts_blocked(self):
        for p in ["orgs/main/agents/jarvis/SOUL.md", "orgs/main/agents/jarvis/GUARDRAILS.md"]:
            r = guard.check(p)
            self.assertEqual(r["decision"], "BLOCK", p)
            self.assertEqual(r["protected_class"], "live-prompts", p)

    def test_permissions_blocked(self):
        r = guard.check(".claude/settings.json")
        self.assertEqual(r["decision"], "BLOCK")
        self.assertEqual(r["protected_class"], "permissions")

    def test_non_protected_path_allowed(self):
        r = guard.check("README.md")
        self.assertEqual(r["decision"], "ALLOW")
        self.assertIsNone(r["protected_class"])
        r2 = guard.check("system-model/components.json")
        self.assertEqual(r2["decision"], "ALLOW")

    def test_protected_write_blocked_without_valid_record(self):
        # Even WITH a token, if no human-approved record exists, it stays blocked.
        os.environ["RELEASE_FLOW_AUTHORIZED"] = "nonexistent-release-id"
        r = guard.check("orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json",
                        release_id="nonexistent-release-id")
        self.assertEqual(r["decision"], "BLOCK")
        self.assertIn("no release record", r["reason"])

    def test_protected_write_blocked_when_record_not_human_approved(self):
        # The example framework record exists but human_approved=false -> still BLOCK.
        rid = "release-system-framework-2026-06-21"
        record = REPO_ROOT / "releases" / "records" / f"{rid}.json"
        if record.exists():
            os.environ["RELEASE_FLOW_AUTHORIZED"] = rid
            r = guard.check("orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json",
                            release_id=rid)
            self.assertEqual(r["decision"], "BLOCK")
            self.assertIn("not human_approved", r["reason"])

    def test_cli_exit_code_block_is_3(self):
        rc = guard.main(["orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json"])
        self.assertEqual(rc, 3)

    def test_cli_exit_code_allow_is_0(self):
        rc = guard.main(["README.md"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
