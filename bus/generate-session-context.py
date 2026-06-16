#!/usr/bin/env python3
"""Generate session-context.md for memory Layer 4 boot injection.

Extracts key information from the most recent completed session transcript
and recent git activity, writing a compact summary that agents read at
session start. Designed to be fast even with 250MB+ transcript files.

Usage: generate-session-context.py <agent-name> <org>
Output: orgs/<org>/agents/<agent>/state/session-context.md
"""

import json
import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime, timezone

def find_transcripts(agent_name: str, org: str) -> list[Path]:
    projects_dir = Path.home() / ".claude" / "projects"
    framework_root = os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))
    agent_path = Path(framework_root) / "orgs" / org / "agents" / agent_name
    slug = str(agent_path).replace("/", "-")
    if slug.startswith("-"):
        slug = slug[1:]
    transcript_dir = projects_dir / f"-{slug}"
    if not transcript_dir.exists():
        for d in projects_dir.iterdir():
            if d.is_dir() and agent_name in d.name:
                transcript_dir = d
                break
    if not transcript_dir.exists():
        return []
    files = sorted(transcript_dir.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
    return files

def extract_session_summary(transcript_path: Path, max_user_msgs: int = 20) -> dict:
    """Extract key info from transcript, reading only what we need."""
    user_messages = []
    assistant_decisions = []
    session_id = None
    first_ts = None
    last_ts = None

    with open(transcript_path, "r") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            entry_type = entry.get("type")
            ts = entry.get("timestamp")

            if ts:
                if not first_ts:
                    first_ts = ts
                last_ts = ts

            if not session_id and entry.get("sessionId"):
                session_id = entry["sessionId"]

            if entry_type == "user":
                msg = entry.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) > 10:
                    if not any(skip in content[:50] for skip in [
                        "CRON FIRED", "BRIEF-WINDOW", "task-notification",
                        "system-reminder", "Read HEARTBEAT"
                    ]):
                        user_messages.append({
                            "ts": ts,
                            "text": content[:500],
                            "source": entry.get("userType", "unknown")
                        })

            elif entry_type == "assistant":
                msg = entry.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, list):
                    text_parts = [b.get("text", "") for b in content if b.get("type") == "text"]
                    content = " ".join(text_parts)
                if isinstance(content, str) and len(content) > 50:
                    lower = content.lower()
                    if any(kw in lower for kw in [
                        "decision", "completed", "built", "fixed", "created",
                        "dispatched", "correction", "b directive", "approved",
                        "blocked", "failed", "error", "incident"
                    ]):
                        assistant_decisions.append({
                            "ts": ts,
                            "text": content[:300]
                        })

    recent_user = user_messages[-max_user_msgs:] if len(user_messages) > max_user_msgs else user_messages
    recent_decisions = assistant_decisions[-15:] if len(assistant_decisions) > 15 else assistant_decisions

    return {
        "session_id": session_id,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "total_user_msgs": len(user_messages),
        "user_messages": recent_user,
        "key_decisions": recent_decisions,
    }

def get_semantic_recall(framework_root: str, queries: list[str], k: int = 2) -> list[str]:
    """Run the LOCAL embedding recall (transcript-semantic.sh) for standing queries
    and return compact top hits. This is the read-back that was missing at boot —
    fully local (all-MiniLM-L6-v2), no Gemini/KB quota. Fails soft."""
    script = Path(framework_root) / "bus" / "transcript-semantic.sh"
    if not script.exists():
        return []
    out: list[str] = []
    for q in queries:
        try:
            res = subprocess.run(
                ["bash", str(script), "search", q, "--k", str(k)],
                capture_output=True, text=True, timeout=30, cwd=framework_root,
            )
            block = res.stdout.strip()
            if not block:
                continue
            # Keep the scored hit lines + their snippet lines, drop the model-load noise.
            kept = []
            for ln in block.splitlines():
                s = ln.strip()
                if not s or "Loading weights" in s or s.startswith("Query:"):
                    continue
                kept.append(ln.rstrip())
            if kept:
                out.append(f"**Recall — _{q}_:**")
                out.extend(kept[:k * 2])
                out.append("")
        except Exception:
            continue
    return out


def get_recent_daily_memory(framework_root: str, agent_name: str, org: str, n_files: int = 2) -> list[str]:
    """Load the tail of the most recent daily-memory file(s) so last session's
    checkpoints + 'for next session' notes are in context at boot."""
    mem_dir = Path(framework_root) / "orgs" / org / "agents" / agent_name / "memory"
    if not mem_dir.exists():
        return []
    files = sorted([f for f in mem_dir.glob("20*-*-*.md")], reverse=True)[:n_files]
    if not files:
        return []
    out: list[str] = []
    for f in files:
        try:
            text = f.read_text()
        except Exception:
            continue
        # Take the last ~40 lines (most recent checkpoints sit at the bottom).
        tail = [ln.rstrip() for ln in text.splitlines() if ln.strip()][-40:]
        if tail:
            out.append(f"### {f.stem} (tail)")
            out.extend(tail)
            out.append("")
    return out


def get_git_log(framework_root: str, n: int = 10) -> str:
    try:
        result = subprocess.run(
            ["git", "log", f"--oneline", f"-{n}", "--no-decorate"],
            capture_output=True, text=True, timeout=5,
            cwd=framework_root
        )
        return result.stdout.strip()
    except Exception:
        return "(git log unavailable)"

def get_git_diff_stat(framework_root: str) -> str:
    try:
        result = subprocess.run(
            ["git", "diff", "--stat", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=framework_root
        )
        return result.stdout.strip()[:500] if result.stdout.strip() else "(clean working tree)"
    except Exception:
        return "(git diff unavailable)"

def get_strategy_verdicts(max_items: int = 25) -> list[str]:
    """Deterministically surface KILLED edges / negative strategy verdicts from disk
    so a boot session can NEVER argue against an on-disk 'this strategy fails' finding
    (root-cause fix for the 2026-06-03 band-mirage failure: the verdict was on disk +
    in MEMORY.md but boot-recall never surfaced it). Scans the prediction deliverables
    dir for verdict files with negative markers; extracts the headline. Fails soft."""
    import re
    candidates = [
        Path(os.environ["CTX_PREDICTION_DELIVERABLES"]) if os.environ.get("CTX_PREDICTION_DELIVERABLES") else None,
        Path.home() / ".openclaw" / "workspace" / "discordbot" / "deliverables",
    ]
    ddir = next((d for d in candidates if d and d.is_dir()), None)
    if not ddir:
        return []
    NEG = ("survives=false", "survives = false", "not fund", "do not fund",
           "nothing to fund", "mirage", "not validated", "no edge", "true-kill",
           "not fundable", "killed")
    out: list[str] = []
    for f in sorted(ddir.glob("*.md")):
        try:
            text = f.read_text(errors="ignore")
        except Exception:
            continue
        if not any(m in text.lower() for m in NEG):
            continue
        head = None
        META = ("date", "status", "author", "for:", "read-only")
        for m in re.findall(r"\*\*(.+?)\*\*", text, re.S):
            cand = m.strip().replace("\n", " ")
            if cand and not any(cand.lower().startswith(p) for p in META) and len(cand) > 12:
                head = cand; break
        if not head:
            for ln in text.splitlines():
                if ln.startswith("#"):
                    head = ln.lstrip("# ").strip(); break
        out.append(f"- **{f.stem}** — {(head or '')[:160]}")
        if len(out) >= max_items:
            break
    return out


def get_trading_systems_state() -> list[str]:
    """Deterministically surface the LIVE state of EACH distinct trading system from disk,
    so a boot session can NEVER again (a) blur two separate systems together, or (b) forget
    what has actually traded real money. Root-cause fix for the 2026-06-03 confusion where
    Jarvis said 'never traded / zero' (true of the Alpaca options bot) while real money had
    in fact traded+lost on Kalshi/Sidewinder — two different systems collapsed into one.
    Queries the real DBs every boot; reports real vs paper separately. Fails soft."""
    import sqlite3
    home = Path.home()
    out: list[str] = []

    # --- System 1: Kalshi / Sidewinder (prediction markets) ---
    pred_db = home / ".openclaw" / "workspace" / "discordbot" / "prediction" / "state" / "prediction_trades.db"
    if pred_db.is_file():
        try:
            con = sqlite3.connect(f"file:{pred_db}?mode=ro", uri=True)
            rows = dict()
            for pm, cnt, pnl in con.execute(
                "SELECT paper_mode, COUNT(*), ROUND(SUM(COALESCE(pnl,0)),2) FROM prediction_trades GROUP BY paper_mode"):
                rows[pm] = (cnt, pnl)
            con.close()
            real_cnt, real_pnl = rows.get(0, (0, 0.0))
            paper_cnt, paper_pnl = rows.get(1, (0, 0.0))
            out.append(f"- **KALSHI / Sidewinder (prediction markets)** — REAL money: {real_cnt} trades, net ${real_pnl} (REAL P&L). "
                       f"Paper: {paper_cnt} trades, net ${paper_pnl} (THEORETICAL, not real). "
                       f"Status: real-money FROZEN (2026-06-03); paper lanes run for data only.")
        except Exception as e:
            out.append(f"- **KALSHI / Sidewinder** — (could not read prediction_trades.db: {e})")

    # --- System 2: Alpaca options bot (Discord) — SEPARATE system ---
    # CRITICAL: query the REAL Alpaca broker, NOT the bot's own positions.db. On 2026-06-03
    # the local DB said trades=0 while the broker showed a real -$40 options trade (Jun 2) the
    # bot placed but never recorded. The bot's own numbers LIE; the broker is authoritative
    # ([[feedback_reconcile_pnl_vs_broker]]). Fail-soft: if the broker can't be read, say so —
    # do NOT fall back to the local DB.
    # PATH FIX 2026-06-10 (T10): the LIVE bot lives at ~/.openclaw/workspace/discordbot/
    # (launchd ai.discordbot.agent; KILL_SWITCH_PATH = discordbot/KILL_SWITCH per
    # src/discordbot/services/halt_state.py). The old scan pointed at the DEAD May-12
    # prototype dir discord-options-bot/, whose leftover KILL_SWITCH file made the boot
    # index claim "ARMED" while the live bot was actually live/disarmed (stale-claim bug).
    opt_dir = home / ".openclaw" / "workspace" / "discordbot"
    if opt_dir.is_dir():
        ks = "ARMED" if (opt_dir / "KILL_SWITCH").exists() else "ABSENT (= live/disarmed)"
        broker_line = None
        try:
            import urllib.request, json, subprocess
            def _kc(n):
                return subprocess.check_output(
                    ["security", "find-generic-password", "-s", n, "-w"], timeout=4).decode().strip()
            key = _kc("discordbot_alpaca_live_key"); sec = _kc("discordbot_alpaca_live_secret")
            hdr = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec}
            def _get(path):
                r = urllib.request.Request("https://api.alpaca.markets/v2" + path, headers=hdr)
                return json.load(urllib.request.urlopen(r, timeout=6))
            acct = _get("/account")
            acts = _get("/account/activities?after=2026-06-01")
            acts = acts if isinstance(acts, list) else []
            fills = [a for a in acts if a.get("activity_type") == "FILL"]
            realized = 0.0
            for a in fills:
                px = float(a.get("price", 0)); qty = float(a.get("qty", 0))
                realized += (px * qty * 100) * (1 if a.get("side") == "sell" else -1)
            fees = sum(float(a.get("net_amount", 0)) for a in acts if a.get("activity_type") == "FEE")
            broker_line = (f"REAL (Alpaca live broker): equity ${acct.get('equity')}, "
                           f"{len(fills)} option fills since Jun 1, realized P&L ${realized + fees:.2f} (incl fees).")
        except Exception as e:
            broker_line = f"REAL broker UNREAD ({type(e).__name__}) — query Alpaca live directly before any claim; do NOT trust local positions.db (it under-records)."
        out.append(f"- **ALPACA OPTIONS BOT (Discord)** — SEPARATE system from Kalshi. {broker_line} "
                   f"KILL_SWITCH: {ks}. NOTE: bot's own positions.db UNDER-RECORDS (placed a real Jun-2 trade it never logged) — broker is truth.")

    return out


def get_agent_runtimes(framework_root: str, org: str) -> tuple[list[str], list[str]]:
    """Surface each fleet agent's ACTUAL runtime live from its config.json, plus any
    codex-fallback runtime-override stamp. Makes 'which agent is on which runtime' a
    live-from-disk fact (same self-healing class as the trading registry) instead of
    static dream-cadence prose. Root-cause fix for the 2026-06-15 recall-miss: codex-
    fallback.sh flipped forge/hermes to claude-code but wrote nothing to memory, so the
    static 'Forge/Hermes DOWN, Codex-capped' fact stayed wrong ~13h.

    Returns (runtime_lines, mismatch_banner_lines). The banner fires when static memory
    still asserts an agent is down/capped while its live config.json says claude-code.
    Fails soft."""
    agents_dir = Path(framework_root) / "orgs" / org / "agents"
    if not agents_dir.is_dir():
        return [], []

    # Load the codex-fallback override stamp (live record of any runtime flip).
    overrides = {}
    override_path = Path(framework_root) / "orgs" / org / "agents" / "jarvis" / "state" / "agent-runtime-overrides.json"
    try:
        if override_path.is_file():
            raw = json.loads(override_path.read_text())
            if isinstance(raw, dict):
                overrides = {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, dict)}
    except Exception:
        overrides = {}

    runtime_lines: list[str] = []
    runtimes: dict[str, str] = {}
    for cfg in sorted(agents_dir.glob("*/config.json")):
        agent = cfg.parent.name
        # Skip scratch/draft/test workspaces — only real fleet agents.
        if agent.startswith("_") or agent.startswith(".") or "test-" in agent or agent.endswith("-study") or agent.endswith("-redesign") or agent.endswith("-drafts"):
            continue
        try:
            d = json.loads(cfg.read_text())
        except Exception:
            continue
        # config.json may omit runtime; cortextOS default is claude-code.
        runtime = d.get("runtime") or "claude-code"
        model = d.get("model", "?")
        runtimes[agent] = runtime
        fb = " ⚠️_codex-fallback active_" if d.get("_codex_fallback_active") else ""
        ov = overrides.get(agent)
        ov_note = ""
        if ov:
            ov_note = (f" · override: {ov.get('from_runtime','?')}→{ov.get('to_runtime','?')} "
                       f"({ov.get('reason','')}) @ {ov.get('timestamp','?')}")
        runtime_lines.append(f"- **{agent}** — runtime=`{runtime}`, model=`{model}`{fb}{ov_note}")

    # Interim guard: scan static memory prose for stale 'down/capped' claims that
    # contradict a live claude-code runtime. If found, emit a trust-config banner.
    mismatch: list[str] = []
    DOWN_MARKERS = ("down", "capped", "weekly-cap", "outage", "cannot run", "offline")
    mem_candidates = [
        Path.home() / ".claude" / "projects" / "-Users-chrisjackson-cortextos" / "memory" / "MEMORY.md",
        Path.home() / ".claude" / "projects" / "-Users-chrisjackson-cortextos" / "memory" / "forge-facts.md",
        Path.home() / ".claude" / "projects" / "-Users-chrisjackson-cortextos" / "memory" / "codex-facts.md",
    ]
    for agent, runtime in runtimes.items():
        if runtime != "claude-code":
            continue
        for mp in mem_candidates:
            try:
                if not mp.is_file():
                    continue
                text = mp.read_text(errors="ignore").lower()
            except Exception:
                continue
            # Look at lines that name the agent AND assert a down/capped state, with the
            # marker in close proximity (≤40 chars) to the agent name so we don't flag a
            # multi-agent headline that merely mentions the agent and 'capped' far apart.
            CORRECTION_MARKERS = ("superseded", "✅", "stop relaying", "stop saying",
                                  "not down", "is alive", "correction", "alive on claude")
            hit = False
            for ln in text.splitlines():
                if agent not in ln:
                    continue
                # Skip lines that are themselves corrections (they mention the agent + a
                # down-marker only to refute it) — those are not stale assertions.
                if any(c in ln for c in CORRECTION_MARKERS):
                    continue
                # Check EVERY occurrence of the agent name — a down-marker within ±40 chars
                # of ANY occurrence on the line is a stale assertion.
                start = 0
                near = False
                while True:
                    idx = ln.find(agent, start)
                    if idx == -1:
                        break
                    window = ln[max(0, idx - 40): idx + len(agent) + 40]
                    if any(m in window for m in DOWN_MARKERS):
                        near = True
                        break
                    start = idx + len(agent)
                if near:
                    mismatch.append(
                        f"- **{agent}**: live config.json = `claude-code` (ALIVE), but `{mp.name}` "
                        f"still asserts down/capped near it. TRUST config.json — the prose is stale.")
                    hit = True
                    break
            if hit:
                break

    return runtime_lines, mismatch


def get_strategist_decisions(max_chars: int = 1800) -> str:
    """ONE-WAY bridge (B directive 2026-06-03 #1): surface the Strategist's decisions at boot so
    decisions B makes in the Strategist chat aren't invisible to Jarvis. READ-ONLY — reads the
    Strategist's MEMORY.md index; NEVER writes back into the Strategist store. Quota-free (file
    read, not embeddings), deterministic, always-current at boot. Fails soft."""
    p = Path.home() / ".claude" / "projects" / "-Users-chrisjackson-cortextos-build" / "memory" / "MEMORY.md"
    try:
        if not p.is_file():
            return ""
        text = p.read_text(errors="ignore").strip()
        # Prefer the Quick Reference / latest section if present; else the head.
        for marker in ("## Quick Reference", "## Recent", "## Latest"):
            i = text.find(marker)
            if i != -1:
                return text[i:i + max_chars].rstrip()
        return text[:max_chars].rstrip()
    except Exception:
        return ""


def get_reflexes(framework_root: str, agent_name: str, org: str) -> str:
    """Read the Jarvis-owned established-workflow reflexes file so 'how do I do X' rules surface at
    DECISION time, not just sit in storage. Fix for the forgotten-workflow failure class (e.g. the
    2026-06-03 yt-dlp recall-miss). Fails soft."""
    p = Path(framework_root) / "orgs" / org / "agents" / agent_name / "memory" / "reflexes.md"
    try:
        return p.read_text(errors="ignore").strip() if p.is_file() else ""
    except Exception:
        return ""


def generate_context(agent_name: str, org: str) -> str:
    framework_root = os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))
    transcripts = find_transcripts(agent_name, org)

    lines = [
        "# Session Context (auto-generated at boot)",
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        ""
    ]

    # ---- MEMORY RECALL (read-back at boot — the fix for write-heavy/read-light) ----
    # Standing queries target the things most often "forgotten": money/account state,
    # active plans, and recent B corrections. Local embeddings, no quota.
    recall = get_semantic_recall(framework_root, [
        "account funding balance real money positions live trading state",
        "active projects plans and open decisions or blockers",
        "recent B corrections directives and locked decisions",
        "strategy backtest verdict killed edge not fundable mirage negative finding",
    ])
    strat = get_strategist_decisions()
    if strat:
        lines.append("## 🧭 Strategist Decisions (one-way bridge, READ-ONLY — do NOT write back)")
        lines.append("_Surfaced from the Strategist chat's memory so B's Strategist-side decisions are visible here. Read-only mirror; never edit the Strategist store._")
        lines.append(strat)
        lines.append("---")
        lines.append("")

    reflexes = get_reflexes(framework_root, agent_name, org)
    # WORKSTREAM 1 — FAN-OUT REFLEX is hardcoded (not file-driven) so it ALWAYS
    # surfaces at decision time even if reflexes.md is missing/unreadable. This
    # is the parallel-by-default orchestration rule from B's 2026-06-15 directive.
    fanout_reflex = (
        "- **FAN-OUT (hard rule, fire at DECISION time):** On ANY request with >=2 independent units, "
        "or any task >~2 steps: FIRST enumerate the independent units, THEN spawn one worker per unit "
        "IN A SINGLE TURN (background each with & to dispatch >=3 at once), THEN monitor + join. "
        "RAIL: use the NATIVE `cortextos spawn-worker <name> --dir <abspath> --prompt \"...\" --parent jarvis` "
        "(that is the rail `cortextos list-workers` and the bus measure; the harness Agent tool is parallel "
        "but INVISIBLE to list-workers). --dir is REQUIRED. Prove fan-out with `cortextos list-workers` >=3 running. "
        "NEVER do independent units inline in the orchestrator session. NEVER narrate 'parallel' "
        "while dispatching serially - that is banned."
    )
    if reflexes or fanout_reflex:
        lines.append("## ⚡ Established Workflows / Reflexes (surface at DECISION time)")
        lines.append("_Saved B-feedback + workflows that were forgotten-at-decision before. Apply reflexively._")
        lines.append(fanout_reflex)
        if reflexes:
            lines.append(reflexes)
        lines.append("---")
        lines.append("")

    systems = get_trading_systems_state()
    if systems:
        lines.append("## 💰 Trading Systems Registry (live from disk — these are DISTINCT systems, do NOT blur them)")
        lines.append("_Each line is a SEPARATE trading system with its own real-money state, queried from its DB at boot. "
                     "Before stating anything about trades/P&L/'never traded', name the SYSTEM and use these numbers — "
                     "never generalize one system's status to another (root-cause fix for the 2026-06-03 Kalshi-vs-options blur)._")
        lines.extend(systems)
        lines.append("---")
        lines.append("")
    runtime_lines, runtime_mismatch = get_agent_runtimes(framework_root, org)
    if runtime_mismatch:
        lines.append("## ⚠️ RUNTIME MISMATCH — trust config.json over memory prose")
        lines.append("_A static memory file still asserts an agent is down/capped while its LIVE "
                     "config.json says `claude-code` (alive). The prose is stale — trust config.json. "
                     "(Interim guard for the 2026-06-15 recall-miss class.)_")
        lines.extend(runtime_mismatch)
        lines.append("---")
        lines.append("")
    if runtime_lines:
        lines.append("## ⚙️ FLEET RUNTIME (live from config.json)")
        lines.append("_Each agent's ACTUAL runtime read from its config.json this run, plus any "
                     "codex-fallback override stamp. This is a LIVE-from-disk fact (self-healing, same "
                     "class as the trading registry) — never trust stale prose about which agent is "
                     "'down'/'on Codex'/'capped'; trust THIS. (Root-cause fix for the 2026-06-15 "
                     "runtime-flip recall-miss.)_")
        lines.extend(runtime_lines)
        lines.append("---")
        lines.append("")
    verdicts = get_strategy_verdicts()
    if verdicts:
        lines.append("## ⛔ Strategy Verdicts / Killed Edges (from disk — do NOT re-argue or re-fund these)")
        lines.append("_Deterministic scan of prediction deliverables for negative/killed verdicts. If a new assertion contradicts one of these, DISK WINS — re-read the file before claiming otherwise (root-cause fix for the band-mirage failure)._")
        lines.extend(verdicts)
        lines.append("---")
        lines.append("")
    daily = get_recent_daily_memory(framework_root, agent_name, org)
    if recall or daily:
        lines.append("## 🧠 Memory Recall — READ THIS FIRST (auto-injected from local memory)")
        lines.append("_These are facts from your own stored memory, surfaced at boot so you don't re-ask or forget. Verify live state before acting on stale facts._")
        lines.append("")
        if daily:
            lines.append("### Recent daily memory (last session checkpoints)")
            lines.extend(daily)
        if recall:
            lines.append("### Semantic recall (local embeddings)")
            lines.extend(recall)
        lines.append("---")
        lines.append("")

    if len(transcripts) >= 2:
        prev = transcripts[1]
        summary = extract_session_summary(prev)
        lines.append("## Last Completed Session")
        lines.append(f"- ID: `{summary['session_id'] or 'unknown'}`")
        lines.append(f"- Period: {summary['first_ts'] or '?'} → {summary['last_ts'] or '?'}")
        lines.append(f"- User messages: {summary['total_user_msgs']}")
        lines.append("")

        if summary["user_messages"]:
            lines.append("### Key User Messages")
            for msg in summary["user_messages"]:
                src = f" [{msg['source']}]" if msg["source"] != "unknown" else ""
                text = msg["text"].replace("\n", " ")[:200]
                lines.append(f"- {text}{src}")
            lines.append("")

        if summary["key_decisions"]:
            lines.append("### Key Decisions/Actions")
            for dec in summary["key_decisions"]:
                text = dec["text"].replace("\n", " ")[:200]
                lines.append(f"- {text}")
            lines.append("")
    elif len(transcripts) == 1:
        lines.append("## Last Completed Session")
        lines.append("(No prior completed session found — this may be the first.)")
        lines.append("")
    else:
        lines.append("## Last Completed Session")
        lines.append("(No transcripts found.)")
        lines.append("")

    lines.append("## Recent Git Activity")
    lines.append("```")
    lines.append(get_git_log(framework_root))
    lines.append("```")
    lines.append("")
    lines.append("### Working Tree")
    lines.append("```")
    lines.append(get_git_diff_stat(framework_root))
    lines.append("```")

    return "\n".join(lines)

def write_boot_index(framework_root: str, agent_name: str, org: str, content: str) -> Path:
    """Refresh the Jarvis-OWNED boot index (agents/<agent>/MEMORY.md) from the freshly generated
    session-context EVERY run. This is the un-re-freezable fix for the 36-day-stale MEMORY.md
    (the dream skill refreshes ~/.claude — the SHARED/Strategist index — NOT this Jarvis file).
    Because generate-session-context runs at every boot AND on the scheduled memory-maintenance
    loop, this index can never drift stale again. Authoritative live index = session-context.md;
    this mirrors its decision-critical sections so the file CLAUDE.md step-2 loads is always current.
    NOT ~/.claude (that's shared/Strategist — never point the loader there)."""
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    # Slice the decision-critical sections (registry + killed-edges + recall) out of the context.
    crit = content
    start = content.find("## ⚡ Established Workflows / Reflexes")
    if start == -1:
        start = content.find("## 💰 Trading Systems Registry")
    end = content.find("## Last Completed Session")
    if start != -1 and end != -1 and end > start:
        crit = content[start:end].rstrip()
    header = (
        f"# {agent_name} — Boot Index (AUTO-GENERATED, do NOT hand-edit)\n"
        f"Regenerated: {ts} · source: state/session-context.md (regenerated each boot + on the "
        f"memory-maintenance loop). This is the Jarvis-OWNED authoritative boot index — NOT "
        f"~/.claude (that is the shared/Strategist index). If this timestamp is stale, the "
        f"keep-fresh loop has stopped — investigate the scheduler.\n\n"
        f"> Full live context: `state/session-context.md`. Long-term notes: `memory/YYYY-MM-DD.md`.\n\n"
    )
    out = Path(framework_root) / "orgs" / org / "agents" / agent_name / "MEMORY.md"
    out.write_text(header + crit + "\n")

    # C1 FIX (red-team 2026-06-03): MEMORY.md only loads if the agent voluntarily runs the boot
    # step — NOT guaranteed (esp. on --continue restarts), and the harness auto-loads the SHARED
    # ~/.claude index, not this one. The daemon DOES unconditionally inject {agentDir}/local/*.md
    # via --append-system-prompt every session (src/pty/agent-pty.ts). So ALSO write a COMPACT
    # guaranteed-injected copy there: the must-never-forget sections only (reflexes + registry +
    # killed-edges), kept small because it is appended to every system prompt.
    def _section(hdr_prefix: str) -> str:
        parts = content.split("\n## ")
        for p in parts:
            if p.startswith(hdr_prefix.lstrip("# ")) or ("## " + p).startswith(hdr_prefix):
                body = p
                # trim at a section-divider if present
                cut = body.find("\n---")
                return ("## " + body[:cut]).rstrip() if cut != -1 else ("## " + body).rstrip()
        return ""
    compact = "\n\n".join(s for s in [
        _section("## ⚠️ RUNTIME MISMATCH"),
        _section("## ⚙️ FLEET RUNTIME"),
        _section("## ⚡ Established Workflows / Reflexes"),
        _section("## 💰 Trading Systems Registry"),
        _section("## ⛔ Strategy Verdicts / Killed Edges"),
    ] if s)
    local_dir = Path(framework_root) / "orgs" / org / "agents" / agent_name / "local"
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / "boot-index.md").write_text(
        f"# AUTO-INJECTED BOOT INDEX (regenerated {ts}) — guaranteed every session via local/ append.\n"
        f"# Decision-critical, do NOT hand-edit. Full context: state/session-context.md.\n\n"
        + compact + "\n")
    return out


def main():
    if len(sys.argv) < 3:
        print("Usage: generate-session-context.py <agent-name> <org>", file=sys.stderr)
        sys.exit(1)

    agent_name = sys.argv[1]
    org = sys.argv[2]
    framework_root = os.environ.get("CTX_FRAMEWORK_ROOT", str(Path.home() / "cortextos"))
    output_dir = Path(framework_root) / "orgs" / org / "agents" / agent_name / "state"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "session-context.md"

    content = generate_context(agent_name, org)
    output_path.write_text(content)
    print(f"Written: {output_path} ({len(content)} bytes)")
    try:
        idx = write_boot_index(framework_root, agent_name, org, content)
        print(f"Boot index refreshed: {idx}")
    except Exception as e:
        print(f"WARN: boot index refresh failed: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
