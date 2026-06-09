#!/usr/bin/env python3
"""Auto-dashboard agent V1.

Phase 1 only:
- audit live source coverage against what dashboard pages currently render
- weight gaps by recent attention/work-state
- write a structured JSON report plus a short markdown summary

This script is intentionally heuristic and file-system driven. It does not edit
dashboard pages.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import math
import os
import pathlib
import re
import sqlite3
from typing import Any


REPO_ROOT = pathlib.Path.home() / "cortextos"
DASHBOARD_ROOT = REPO_ROOT / "dashboard"
JARVIS_ROOT = REPO_ROOT / "orgs" / "main" / "agents" / "jarvis"
HERMES_OUTPUT_DIR = REPO_ROOT / "orgs" / "main" / "agents" / "hermes" / "outputs"
CRYPTO_ENGINE_ROOT = pathlib.Path(
    os.environ.get("FORWARD_TRACKING_ROOT", str(pathlib.Path.home() / "cortextos-data" / "crypto-engine"))
)
FORWARD_TRACKING_DIR = CRYPTO_ENGINE_ROOT / "forward_tracking"
DISCORDBOT_STATE_DIR = pathlib.Path.home() / ".openclaw" / "workspace" / "discordbot" / "state"
CTX_ROOT = pathlib.Path.home() / ".cortextos" / "default"
DASHBOARD_DB = CTX_ROOT / "dashboard" / "cortextos-default.db"

DEFAULT_JSON_REPORT = HERMES_OUTPUT_DIR / "2026-06-05-dashboard-agent-v1-report.json"
DEFAULT_MD_REPORT = HERMES_OUTPUT_DIR / "2026-06-05-dashboard-agent-v1-report.md"

TOPIC_PATTERNS = {
    "shib_probe": [r"\bshib\b", r"\bprobe\b", r"kraken"],
    "lead_lag": [r"lead-?lag", r"\blag[246]\b", r"avax", r"\beth\b"],
    "options": [r"\boptions?\b", r"alpaca", r"jpm", r"discordbot"],
    "dashboard_agent": [r"dashboard", r"/predictions", r"/advisor", r"/futures", r"/decisions"],
    "decisions": [r"\bdecision", r"\bidea", r"\bapproval"],
    "deliverables": [r"deliverable", r"\bmemo\b", r"\breport\b"],
    "sports": [r"sports?", r"draftkings", r"parlay"],
    "build_loop": [r"\bloop\b", r"iteration", r"jarvis build", r"memory v2"],
}

SOURCE_REGISTRY = [
    {
        "key": "shib_probe_live_state",
        "label": "SHIB probe live state",
        "paths": [FORWARD_TRACKING_DIR / "shib_kraken_probe_status.json"],
        "topic_tags": ["shib_probe", "lead_lag"],
        "page_candidates": ["overview", "predictions", "futures", "options"],
        "importance": 1.0,
    },
    {
        "key": "lead_lag_cluster_paper",
        "label": "Lead-lag paper cluster",
        "globs": [str(FORWARD_TRACKING_DIR / "cluster_paper" / "*.jsonl")],
        "topic_tags": ["lead_lag", "shib_probe"],
        "page_candidates": ["futures", "predictions", "overview"],
        "importance": 0.85,
    },
    {
        "key": "options_bot_live_state",
        "label": "Options bot live state",
        "paths": [
            DISCORDBOT_STATE_DIR / "account-snapshot.json",
            DISCORDBOT_STATE_DIR / "intent-ledger.db",
            DISCORDBOT_STATE_DIR / "broker-health.db",
        ],
        "topic_tags": ["options"],
        "page_candidates": ["options", "overview"],
        "importance": 0.95,
    },
    {
        "key": "options_preflight_due",
        "label": "Options preflight marker",
        "paths": [JARVIS_ROOT / "state" / "options-preflight-due.json"],
        "topic_tags": ["options", "decisions"],
        "page_candidates": ["options", "decisions", "overview"],
        "importance": 0.8,
    },
    {
        "key": "ideas_decisions",
        "label": "Ideas and decisions store",
        "paths": [JARVIS_ROOT / "state" / "ideas-decisions.json"],
        "topic_tags": ["decisions", "dashboard_agent"],
        "page_candidates": ["decisions", "overview"],
        "importance": 0.9,
    },
    {
        "key": "pending_decisions_store",
        "label": "Pending decisions store",
        "paths": [JARVIS_ROOT / "state" / "pending-decisions.json"],
        "topic_tags": ["decisions"],
        "page_candidates": ["decisions", "overview"],
        "importance": 0.7,
    },
    {
        "key": "jarvis_build_loop",
        "label": "Jarvis build loop state",
        "paths": [JARVIS_ROOT / "state" / "loop-state.json"],
        "topic_tags": ["build_loop", "dashboard_agent"],
        "page_candidates": ["overview"],
        "importance": 0.75,
    },
    {
        "key": "jarvis_session_context",
        "label": "Jarvis session context",
        "paths": [JARVIS_ROOT / "state" / "session-context.md"],
        "topic_tags": ["dashboard_agent", "decisions", "shib_probe", "options"],
        "page_candidates": ["overview", "decisions", "advisor", "predictions"],
        "importance": 0.8,
    },
    {
        "key": "jarvis_daily_memory",
        "label": "Jarvis daily memory",
        "globs": [str(JARVIS_ROOT / "memory" / "*.md")],
        "topic_tags": ["dashboard_agent", "shib_probe", "options", "deliverables"],
        "page_candidates": ["overview", "decisions"],
        "importance": 0.7,
    },
    {
        "key": "recent_deliverables",
        "label": "Recent deliverables",
        "globs": [str(JARVIS_ROOT / "deliverables" / "*.md")],
        "topic_tags": ["deliverables", "dashboard_agent"],
        "page_candidates": ["overview", "advisor", "futures", "predictions", "decisions"],
        "importance": 0.7,
    },
    {
        "key": "sports_picks_log",
        "label": "Sports picks log",
        "paths": [JARVIS_ROOT / "state" / "sports-picks-log.jsonl"],
        "topic_tags": ["sports"],
        "page_candidates": ["advisor", "decisions", "overview"],
        "importance": 0.55,
    },
    {
        "key": "fleet_heartbeats",
        "label": "Fleet heartbeats",
        "globs": [str(CTX_ROOT / "state" / "*" / "heartbeat.json")],
        "topic_tags": ["build_loop", "dashboard_agent"],
        "page_candidates": ["overview", "agents"],
        "importance": 0.75,
    },
]

API_SOURCE_MAP = {
    "live-forward": ["shib_probe_live_state", "lead_lag_cluster_paper"],
    "crypto-engine": ["lead_lag_cluster_paper"],
    "options": ["options_bot_live_state"],
    "ideas-decisions": ["ideas_decisions"],
}

PAGE_FILE_MAP = {
    "overview": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "page.tsx",
    "predictions": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "predictions" / "page.tsx",
    "futures": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "futures" / "page.tsx",
    "options": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "options" / "page.tsx",
    "advisor": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "advisor" / "page.tsx",
    "decisions": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "decisions" / "page.tsx",
    "agents": DASHBOARD_ROOT / "src" / "app" / "(dashboard)" / "agents" / "page.tsx",
}


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def read_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def latest_match(pattern: str) -> pathlib.Path | None:
    matches = [pathlib.Path(value) for value in glob.glob(pattern)]
    if not matches:
        return None
    return max(matches, key=lambda path: path.stat().st_mtime)


def latest_daily_memory_text() -> str:
    latest = latest_match(str(JARVIS_ROOT / "memory" / "*.md"))
    return read_text(latest) if latest else ""


def query_active_tasks() -> list[dict[str, Any]]:
    if not DASHBOARD_DB.exists():
        return []
    query = """
        SELECT id, title, COALESCE(description, '') AS description, status, priority, assignee
        FROM tasks
        WHERE status IN ('in_progress', 'pending')
        ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 25
    """
    try:
        with sqlite3.connect(DASHBOARD_DB) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute(query).fetchall()]
    except Exception:
        return []


def count_topic_hits(text: str, topic: str) -> float:
    patterns = TOPIC_PATTERNS.get(topic, [])
    if not text:
        return 0.0
    score = 0.0
    lowered = text.lower()
    for pattern in patterns:
        score += len(re.findall(pattern, lowered, flags=re.IGNORECASE))
    return score


def build_attention_scores(
    source_topics: dict[str, list[str]],
    memory_text: str,
    session_text: str,
    active_tasks: list[dict[str, Any]],
) -> dict[str, float]:
    topic_scores: dict[str, float] = {topic: 0.0 for topic in TOPIC_PATTERNS}

    for topic in topic_scores:
        topic_scores[topic] += 1.0 * count_topic_hits(memory_text, topic)
        topic_scores[topic] += 1.3 * count_topic_hits(session_text, topic)

    for task in active_tasks:
        blob = " ".join(
            [
                str(task.get("title", "")),
                str(task.get("description", "")),
                str(task.get("assignee", "")),
            ]
        )
        task_weight = 2.2 if task.get("status") == "in_progress" else 0.6
        for topic in topic_scores:
            topic_scores[topic] += task_weight * count_topic_hits(blob, topic)

    source_scores: dict[str, float] = {}
    for source_key, topics in source_topics.items():
        raw_score = sum(topic_scores.get(topic, 0.0) for topic in topics)
        source_scores[source_key] = round(math.log1p(raw_score) * 3.0, 4)
    return source_scores


def source_exists(entry: dict[str, Any]) -> tuple[bool, list[str], dt.datetime | None]:
    matches: list[pathlib.Path] = []
    for path in entry.get("paths", []):
        if pathlib.Path(path).exists():
            matches.append(pathlib.Path(path))
    for pattern in entry.get("globs", []):
        matches.extend(pathlib.Path(value) for value in glob.glob(pattern))

    if not matches:
        return False, [], None

    newest = max(matches, key=lambda path: path.stat().st_mtime)
    return True, sorted({str(match) for match in matches}), dt.datetime.fromtimestamp(newest.stat().st_mtime, dt.timezone.utc)


def recency_bonus(last_seen_at: dt.datetime | None) -> float:
    if last_seen_at is None:
        return 0.0
    age_hours = (dt.datetime.now(dt.timezone.utc) - last_seen_at).total_seconds() / 3600
    if age_hours <= 6:
        return 0.2
    if age_hours <= 24:
        return 0.12
    if age_hours <= 72:
        return 0.05
    return 0.0


def collect_sources() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for entry in SOURCE_REGISTRY:
        exists, matched_paths, last_seen_at = source_exists(entry)
        sources.append(
            {
                **entry,
                "exists": exists,
                "matched_paths": matched_paths,
                "last_seen_at": last_seen_at.isoformat().replace("+00:00", "Z") if last_seen_at else None,
            }
        )
    return sources


def scan_page_coverage() -> dict[str, dict[str, Any]]:
    coverage: dict[str, dict[str, Any]] = {}

    for page_name, path in PAGE_FILE_MAP.items():
        text = read_text(path)
        source_keys: set[str] = set()
        evidence: list[str] = []

        for api_name, api_source_keys in API_SOURCE_MAP.items():
            marker = f"/api/{api_name}"
            if marker in text:
                source_keys.update(api_source_keys)
                evidence.append(marker)

        if page_name == "overview":
            manual_checks = {
                "JarvisBuildPanel": "jarvis_build_loop",
                "DebriefMemory": "jarvis_daily_memory",
                "AgentStatusGrid": "fleet_heartbeats",
                "ActiveWork": "ideas_decisions",
            }
            for marker, source_key in manual_checks.items():
                if marker in text:
                    source_keys.add(source_key)
                    evidence.append(marker)

        if page_name == "agents" and ("heartbeat" in text.lower() or "logs-tab" in text.lower()):
            source_keys.add("fleet_heartbeats")
            evidence.append("heartbeat")

        coverage[page_name] = {
            "path": str(path),
            "source_keys": sorted(source_keys),
            "evidence": evidence,
        }

    return coverage


def recommend_text(label: str, gap_type: str, covered_pages: list[str], recommended_pages: list[str]) -> str:
    if gap_type == "uncovered":
        target = recommended_pages[0] if recommended_pages else "an appropriate dashboard page"
        return f"Add a module for {label.lower()} on /{target}."
    if gap_type == "undercovered":
        target = recommended_pages[0] if recommended_pages else "a higher-priority page"
        current = f" from /{covered_pages[0]}" if covered_pages else ""
        return f"Promote {label.lower()}{current} onto /{target}."
    return f"Review {label.lower()} coverage."


def detect_coverage_gaps(
    sources: list[dict[str, Any]],
    page_coverage: dict[str, dict[str, Any]],
    attention_scores: dict[str, float],
) -> list[dict[str, Any]]:
    indexed_coverage: dict[str, list[str]] = {}
    for page_name, meta in page_coverage.items():
        for source_key in meta.get("source_keys", []):
            indexed_coverage.setdefault(source_key, []).append(page_name)

    gaps: list[dict[str, Any]] = []
    for source in sources:
        if not source.get("exists"):
            continue

        source_key = source["key"]
        covered_pages = sorted(indexed_coverage.get(source_key, []))
        recommended_pages = source.get("page_candidates", [])
        covered_recommended_pages = [page for page in covered_pages if page in recommended_pages]

        if not covered_pages:
            gap_type = "uncovered"
        elif recommended_pages and not covered_recommended_pages:
            gap_type = "undercovered"
        else:
            continue

        attention = attention_scores.get(source_key, 0.0)
        base = float(source.get("importance", 0.5))
        last_seen = source.get("last_seen_at")
        last_seen_dt = (
            dt.datetime.fromisoformat(last_seen.replace("Z", "+00:00")) if isinstance(last_seen, str) else None
        )
        gap_penalty = 0.18 if gap_type == "uncovered" else 0.25
        priority_score = round(base + attention * 0.08 + recency_bonus(last_seen_dt) + gap_penalty, 4)

        gaps.append(
            {
                "source_key": source_key,
                "label": source["label"],
                "gap_type": gap_type,
                "priority_score": priority_score,
                "attention_score": round(attention, 4),
                "covered_pages": covered_pages,
                "recommended_pages": recommended_pages,
                "matched_paths": source.get("matched_paths", []),
                "last_seen_at": source.get("last_seen_at"),
                "recommendation": recommend_text(source["label"], gap_type, covered_pages, recommended_pages),
            }
        )

    gaps.sort(key=lambda item: item["priority_score"], reverse=True)
    return gaps


def top_topics_from_scores(attention_scores: dict[str, float], source_topics: dict[str, list[str]]) -> list[dict[str, Any]]:
    topic_totals: dict[str, float] = {}
    for source_key, topics in source_topics.items():
        source_score = attention_scores.get(source_key, 0.0)
        for topic in topics:
            topic_totals[topic] = topic_totals.get(topic, 0.0) + source_score
    return [
        {"topic": topic, "score": round(score, 4)}
        for topic, score in sorted(topic_totals.items(), key=lambda item: item[1], reverse=True)
        if score > 0
    ][:5]


def render_markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# Auto-Dashboard Agent V1 Report",
        "",
        f"- Generated: `{report['generated_at']}`",
        f"- Detectable sources: `{report['summary']['detectable_sources']}`",
        f"- Covered sources: `{report['summary']['covered_sources']}`",
        f"- Gaps flagged: `{report['summary']['gap_count']}`",
        "",
        "## Attention",
        "",
    ]

    if report.get("top_attention_topics"):
        for topic in report["top_attention_topics"]:
            lines.append(f"- `{topic['topic']}` · score `{topic['score']}`")
    else:
        lines.append("- No attention topics detected.")

    lines.extend(["", "## Ranked Gaps", ""])
    if not report.get("gaps"):
        lines.append("- No detectable coverage gaps.")
    else:
        for gap in report["gaps"][:8]:
            covered = ", ".join(f"`/{page}`" for page in gap["covered_pages"]) or "`none`"
            recommended = ", ".join(f"`/{page}`" for page in gap["recommended_pages"]) or "`unspecified`"
            lines.append(
                f"- `{gap['source_key']}` ({gap['gap_type']}, score `{gap['priority_score']}`): "
                f"{gap['label']} is on {covered}; recommended pages {recommended}. {gap['recommendation']}"
            )
    lines.append("")
    return "\n".join(lines)


def build_report() -> dict[str, Any]:
    sources = collect_sources()
    source_topics = {source["key"]: source.get("topic_tags", []) for source in sources}
    memory_text = read_text(JARVIS_ROOT / "MEMORY.md") + "\n" + latest_daily_memory_text()
    session_text = read_text(JARVIS_ROOT / "state" / "session-context.md")
    active_tasks = query_active_tasks()
    page_coverage = scan_page_coverage()
    attention_scores = build_attention_scores(source_topics, memory_text, session_text, active_tasks)
    gaps = detect_coverage_gaps(sources, page_coverage, attention_scores)

    existing_source_keys = {source["key"] for source in sources if source["exists"]}
    covered_source_keys = {
        source_key
        for meta in page_coverage.values()
        for source_key in meta.get("source_keys", [])
        if source_key in existing_source_keys
    }

    return {
        "generated_at": iso_now(),
        "summary": {
            "detectable_sources": len(existing_source_keys),
            "covered_sources": len(covered_source_keys),
            "gap_count": len(gaps),
        },
        "paths": {
            "repo_root": str(REPO_ROOT),
            "dashboard_root": str(DASHBOARD_ROOT),
            "jarvis_root": str(JARVIS_ROOT),
        },
        "page_coverage": page_coverage,
        "active_tasks": active_tasks,
        "top_attention_topics": top_topics_from_scores(attention_scores, source_topics),
        "gaps": gaps,
    }


def write_report(report: dict[str, Any], json_path: pathlib.Path, markdown_path: pathlib.Path) -> None:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown_report(report), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the auto-dashboard V1 coverage audit.")
    parser.add_argument("--json-out", default=str(DEFAULT_JSON_REPORT), help="Path for the JSON report.")
    parser.add_argument("--md-out", default=str(DEFAULT_MD_REPORT), help="Path for the markdown report.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report()
    json_path = pathlib.Path(args.json_out).expanduser()
    markdown_path = pathlib.Path(args.md_out).expanduser()
    write_report(report, json_path, markdown_path)
    print(f"wrote_json={json_path}")
    print(f"wrote_markdown={markdown_path}")
    print(f"gap_count={report['summary']['gap_count']}")
    top_gap = report["gaps"][0]["source_key"] if report["gaps"] else "none"
    print(f"top_gap={top_gap}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
