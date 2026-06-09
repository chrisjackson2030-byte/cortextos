import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "auto_dashboard_agent_v1.py"


def load_module():
    spec = importlib.util.spec_from_file_location("auto_dashboard_agent_v1", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class AutoDashboardAgentV1Tests(unittest.TestCase):
    def test_extract_attention_scores_from_memory_and_tasks(self):
        module = load_module()

        source_topics = {
            "shib_probe_live_state": ["shib_probe", "lead_lag"],
            "options_bot_live_state": ["options"],
        }
        memory_text = "SHIB live+flat. SHIB is the current probe. Options bot verified pre-open ready."
        session_text = "Recovered lead-lag family. SHIB probe already forward-tests."
        active_tasks = [
            {"title": "Harden SHIB probe dashboard"},
            {"title": "Options bot follow-up"},
            {"title": "Dashboard agent"},
        ]

        scores = module.build_attention_scores(source_topics, memory_text, session_text, active_tasks)

        self.assertGreater(scores["shib_probe_live_state"], scores["options_bot_live_state"])
        self.assertGreater(scores["shib_probe_live_state"], 0.0)

    def test_detects_uncovered_and_undercovered_sources(self):
        module = load_module()

        sources = [
            {
                "key": "deliverables_recent",
                "label": "Recent deliverables",
                "exists": True,
                "topic_tags": ["deliverables"],
                "page_candidates": ["overview", "advisor"],
                "detectable": True,
            },
            {
                "key": "shib_probe_live_state",
                "label": "SHIB probe live state",
                "exists": True,
                "topic_tags": ["shib_probe"],
                "page_candidates": ["overview", "predictions"],
                "detectable": True,
            },
        ]
        page_coverage = {
            "futures": {"source_keys": ["shib_probe_live_state"]},
            "decisions": {"source_keys": ["ideas_decisions"]},
        }
        attention_scores = {
            "deliverables_recent": 0.6,
            "shib_probe_live_state": 0.9,
        }

        gaps = module.detect_coverage_gaps(sources, page_coverage, attention_scores)
        by_key = {gap["source_key"]: gap for gap in gaps}

        self.assertEqual(by_key["deliverables_recent"]["gap_type"], "uncovered")
        self.assertEqual(by_key["shib_probe_live_state"]["gap_type"], "undercovered")
        self.assertGreater(by_key["shib_probe_live_state"]["priority_score"], by_key["deliverables_recent"]["priority_score"])

    def test_markdown_summary_lists_top_recommendations(self):
        module = load_module()

        report = {
            "generated_at": "2026-06-05T18:30:00Z",
            "summary": {
                "detectable_sources": 3,
                "covered_sources": 1,
                "gap_count": 2,
            },
            "top_attention_topics": [
                {"topic": "shib_probe", "score": 4.0},
                {"topic": "dashboard_agent", "score": 2.0},
            ],
            "gaps": [
                {
                    "source_key": "shib_probe_live_state",
                    "label": "SHIB probe live state",
                    "gap_type": "undercovered",
                    "priority_score": 0.95,
                    "covered_pages": ["futures"],
                    "recommended_pages": ["overview", "predictions"],
                    "recommendation": "Promote SHIB probe state onto /overview.",
                },
                {
                    "source_key": "deliverables_recent",
                    "label": "Recent deliverables",
                    "gap_type": "uncovered",
                    "priority_score": 0.5,
                    "covered_pages": [],
                    "recommended_pages": ["overview"],
                    "recommendation": "Add a recent deliverables module.",
                },
            ],
        }

        markdown = module.render_markdown_report(report)

        self.assertIn("SHIB probe live state", markdown)
        self.assertIn("Promote SHIB probe state onto /overview.", markdown)
        self.assertIn("dashboard_agent", markdown)


if __name__ == "__main__":
    unittest.main()
