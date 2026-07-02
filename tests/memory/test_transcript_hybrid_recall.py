import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "orgs/main/agents/jarvis/state/transcript-embed/embed_transcripts.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("embed_transcripts_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TranscriptHybridRecallTest(unittest.TestCase):
    def test_db_connect_creates_fts5_keyword_mirror(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as td:
            mod.DB_PATH = Path(td) / "transcript-embeddings.db"
            con = mod.db_connect()
            con.execute(
                "INSERT INTO chunks(session_id,file,role,ts,chunk_idx,text,vector) VALUES (?,?,?,?,?,?,?)",
                ("s1", "s1.jsonl", "user", "2026-06-22T12:00:00Z", 0, "Quiet Kiln exact keyword memory", b""),
            )
            row = con.execute(
                "SELECT chunks.id, chunks.text FROM chunks_fts JOIN chunks ON chunks.id = chunks_fts.rowid "
                "WHERE chunks_fts MATCH ?",
                ("Quiet AND Kiln",),
            ).fetchone()

            self.assertEqual(row, (1, "Quiet Kiln exact keyword memory"))

    def test_reciprocal_rank_fusion_prefers_items_found_by_both_paths(self):
        mod = load_module()

        fused = mod.reciprocal_rank_fusion(
            vector_ids=[("semantic-only", 0.91), ("both", 0.88), ("vector-third", 0.7)],
            keyword_ids=[("both", -0.2), ("keyword-only", -0.1)],
        )

        self.assertEqual(fused[0]["id"], "both")
        self.assertEqual(fused[0]["sources"], ["vector", "keyword"])
        self.assertGreater(fused[0]["score"], fused[1]["score"])

    def test_hybrid_search_returns_keyword_only_match_when_vector_misses(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as td:
            mod.DB_PATH = Path(td) / "transcript-embeddings.db"
            con = mod.db_connect()
            con.execute(
                "INSERT INTO chunks(id,session_id,file,role,ts,chunk_idx,text,vector) VALUES (?,?,?,?,?,?,?,?)",
                (101, "s1", "s1.jsonl", "assistant", "2026-06-22T12:00:00Z", 0, "Quiet Kiln invoice code QK-77", b""),
            )
            con.execute(
                "INSERT INTO chunks(id,session_id,file,role,ts,chunk_idx,text,vector) VALUES (?,?,?,?,?,?,?,?)",
                (202, "s2", "s2.jsonl", "user", "2026-06-22T13:00:00Z", 0, "semantic neighbor without literal", b""),
            )
            con.commit()

            results = mod.hybrid_search(
                con,
                "Quiet Kiln",
                k=2,
                vector_scores=[(202, 0.95)],
            )

            ids = [row["id"] for row in results]
            self.assertIn(101, ids)
            self.assertEqual(results[ids.index(101)]["source"], "keyword")
            self.assertEqual(results[ids.index(101)]["timestamp"], "2026-06-22T12:00:00Z")

    def test_content_hash_skip_detects_same_mtime_changed_file(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "session.jsonl"
            path.write_text(json.dumps({"type": "user", "message": {"content": "first meaningful memory text"}}) + "\n")
            fixed_mtime = time.time() - 60
            os.utime(path, (fixed_mtime, fixed_mtime))

            original_hash = mod.file_content_hash(path)
            path.write_text(json.dumps({"type": "user", "message": {"content": "changed meaningful memory text"}}) + "\n")
            os.utime(path, (fixed_mtime, fixed_mtime))

            self.assertNotEqual(mod.file_content_hash(path), original_hash)

    def test_current_session_tail_policy_indexes_old_prefix(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as td:
            old_ts = "2026-06-22T12:00:00.000Z"
            recent_ts = mod._now()
            path = Path(td) / "live.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "user", "timestamp": old_ts, "message": {"content": "old current session tail should be indexed"}}),
                        json.dumps({"type": "user", "timestamp": recent_ts, "message": {"content": "fresh current session tail should wait"}}),
                    ]
                )
                + "\n"
            )

            rows = list(mod.iter_turns(path, exclude_after_epoch=time.time() - 60))

            self.assertEqual(rows, [("user", old_ts, "old current session tail should be indexed")])


if __name__ == "__main__":
    unittest.main()
