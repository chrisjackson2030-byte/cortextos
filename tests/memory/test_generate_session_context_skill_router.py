import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[2] / "bus/generate-session-context.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_session_context_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SkillRouterBootIndexTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.agent = "jarvis"
        self.org = "main"
        self.agent_dir = self.root / "orgs" / self.org / "agents" / self.agent
        (self.agent_dir / "memory").mkdir(parents=True)
        (self.agent_dir / "state").mkdir(parents=True)
        (self.agent_dir / "memory" / "reflexes.md").write_text("REFLEX SENTINEL\n")
        (self.agent_dir / "memory" / "skill-router.md").write_text("SKILL ROUTER SENTINEL\n")
        os.environ["CTX_FRAMEWORK_ROOT"] = str(self.root)

    def tearDown(self):
        self.td.cleanup()

    def quiet_generator(self):
        self.mod.find_transcripts = lambda agent, org: []
        self.mod.get_semantic_recall = lambda framework_root, queries: []
        self.mod.get_strategist_decisions = lambda: ""
        self.mod.get_trading_systems_state = lambda: []
        self.mod.get_agent_runtimes = lambda framework_root, org: ([], [])
        self.mod.get_strategy_verdicts = lambda: []
        self.mod.get_recent_daily_memory = lambda framework_root, agent_name, org: []
        self.mod.get_git_log = lambda framework_root: "git log sentinel"
        self.mod.get_git_diff_stat = lambda framework_root: "git diff sentinel"

    def test_get_skill_router_reads_agent_memory_file(self):
        self.assertEqual(
            self.mod.get_skill_router(str(self.root), self.agent, self.org),
            "SKILL ROUTER SENTINEL",
        )

    def test_generate_context_places_skill_router_after_reflexes(self):
        self.quiet_generator()
        content = self.mod.generate_context(self.agent, self.org)

        reflex_idx = content.index("## ⚡ Established Workflows / Reflexes")
        router_idx = content.index("## 🧰 Skill Router — reach for these at task start (do not hand-roll what a skill covers)")
        last_session_idx = content.index("## Last Completed Session")

        self.assertLess(reflex_idx, router_idx)
        self.assertLess(router_idx, last_session_idx)
        self.assertIn("SKILL ROUTER SENTINEL", content)

    def test_write_boot_index_includes_skill_router_in_compact_local_prompt(self):
        content = "\n".join([
            "# Session Context",
            "",
            "## ⚡ Established Workflows / Reflexes (surface at DECISION time)",
            "REFLEX SENTINEL",
            "---",
            "",
            "## 🧰 Skill Router — reach for these at task start (do not hand-roll what a skill covers)",
            "SKILL ROUTER SENTINEL",
            "---",
            "",
            "## Last Completed Session",
            "done",
        ])

        self.mod.write_boot_index(str(self.root), self.agent, self.org, content)

        memory_text = (self.agent_dir / "MEMORY.md").read_text()
        local_text = (self.agent_dir / "local" / "boot-index.md").read_text()
        self.assertIn("SKILL ROUTER SENTINEL", memory_text)
        self.assertIn("SKILL ROUTER SENTINEL", local_text)


if __name__ == "__main__":
    unittest.main()
