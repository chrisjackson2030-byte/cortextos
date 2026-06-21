#!/usr/bin/env python3
"""
release_proposer.py - PROPOSAL-ONLY self-update release workflow.

PURPOSE
  Future Jarvis self-improvements must go through gates. This tool is how a
  proposed change ENTERS the release flow. It writes a release PROPOSAL record
  to releases/proposals/ and STOPS. It NEVER applies, promotes, flips a flag,
  edits a cron, touches credentials, or makes any production change. There is no
  --apply, no --promote, no --live path in this tool, by design.

CATEGORIES (the proposer assigns one; it cannot promote any of them)
  nightly-safe-update   low-risk, no behavior change (docs, inventories,
                        registry reconciliation proposals, stale-record fixes).
                        Eligible for the lightest gate, but STILL proposal-only:
                        a human/reviewer promotes via the release record + checklist.
  weekly-behavior-release behavior change. REQUIRES independent reviewer + canary
                        before any promotion. Proposal-only here.
  human-approval        anything touching money / risk / trading / credentials /
                        permissions / live-crons / live-prompts. BLOCKED from any
                        autonomous promotion. A human must approve. The proposer
                        will refuse to even classify such a change as anything
                        lighter; it auto-escalates to human-approval.

  The proposer DETECTS the category from the paths the change touches (using the
  live_config_guard classification) and escalates to human-approval whenever a
  protected path is involved, regardless of what the caller requested. A caller
  cannot down-classify a dangerous change.

OUTPUT
  releases/proposals/<proposal_id>.json   (proposal record; reviewer fills the
                                           rest and promotes via a RECORD, not here)

WHAT IT WILL NOT DO
  - apply / promote / merge / deploy
  - write any protected live config
  - set human_approved=true (only a human/reviewer does that, out of band)
  - mutate feature-flags.json, config.json crons, .env, risk/trading settings,
    live prompts, or permissions
"""

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROPOSALS_DIR = REPO_ROOT / "releases" / "proposals"

# Import the guard for path classification (single source of truth for what is protected).
sys.path.insert(0, str(REPO_ROOT / "tools"))
import live_config_guard as guard  # noqa: E402

VALID_CATEGORIES = {"nightly-safe-update", "weekly-behavior-release", "human-approval"}

# Any protected class touched forces human-approval. This is the hard escalation.
PROTECTED_FORCES_HUMAN = True


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def classify_change(paths: list[str], requested_category: str, behavior_change: bool) -> tuple[str, list[str], str]:
    """
    Returns (final_category, protected_classes_hit, escalation_reason).
    Escalation rules (cannot be bypassed by the caller):
      - any protected path  -> human-approval
      - behavior_change     -> at least weekly-behavior-release
      - else                -> requested (default nightly-safe-update)
    """
    protected = []
    for p in paths:
        klass = guard.classify(p)
        if klass:
            protected.append(klass)
    protected = sorted(set(protected))

    if protected and PROTECTED_FORCES_HUMAN:
        return ("human-approval", protected,
                f"touches protected class(es) {protected}; auto-escalated to human-approval")
    if behavior_change and requested_category == "nightly-safe-update":
        return ("weekly-behavior-release", protected,
                "behavior_change=true; cannot be a nightly-safe-update")
    return (requested_category, protected, "no escalation; requested category honored")


def build_proposal(args) -> dict:
    paths = args.path or []
    final_category, protected, escalation = classify_change(
        paths, args.category, args.behavior_change)

    proposal_id = args.proposal_id or f"{args.change_id}-{_dt.datetime.now(_dt.timezone.utc).strftime('%Y%m%d')}"

    requires_reviewer = final_category in {"weekly-behavior-release", "human-approval"}
    requires_canary = final_category in {"weekly-behavior-release", "human-approval"}
    requires_human_approval = final_category == "human-approval"

    return {
        "proposal_id": proposal_id,
        "change_id": args.change_id,
        "summary": args.summary,
        "created_at": _now_iso(),
        "created_by": args.created_by,
        "status": "PROPOSED",                  # never PROMOTED / LIVE from this tool
        "promotion": {
            "auto_promote": False,             # hard false. no autonomous promotion path exists.
            "promoted": False,
            "promoted_by": None,
            "promoted_at": None
        },
        "category": final_category,
        "requested_category": args.category,
        "category_escalation": escalation,
        "paths_touched": paths,
        "protected_classes_touched": protected,
        "behavior_change": bool(args.behavior_change),
        "gates_required": {
            "eval_test_gate": True,            # always
            "independent_reviewer": requires_reviewer,
            "canary_before_promotion": requires_canary,
            "rollback_command_present": True,  # always
            "release_notes_written": True,     # always
            "change_impact_report": True,      # always (RULES.md gate)
            "human_approval": requires_human_approval
        },
        "human_approved": False,               # ONLY a human sets this true, out of band
        "next_step": (
            "Reviewer creates a release RECORD from releases/RELEASE-RECORD-TEMPLATE.json, "
            "runs RELEASE-CHECKLIST.md, attaches the change-impact report, and (for "
            "human-approval category) obtains explicit human approval. Promotion happens "
            "via the reviewed record + checklist, NEVER via this proposer."
        ),
        "change_impact_report_ref": args.impact_ref or "REQUIRED before promotion (see system-model/RULES.md CHANGE-IMPACT REPORT)",
        "rollback": args.rollback or "REQUIRED before promotion: exact undo command(s).",
        "notes": args.notes or ""
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Propose (only) a self-update release. Never applies.")
    ap.add_argument("--change-id", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--category", default="nightly-safe-update", choices=sorted(VALID_CATEGORIES))
    ap.add_argument("--path", action="append", help="a file path the change would touch (repeatable)")
    ap.add_argument("--behavior-change", action="store_true", help="set if the change alters runtime behavior")
    ap.add_argument("--created-by", default="jarvis")
    ap.add_argument("--proposal-id", default=None)
    ap.add_argument("--impact-ref", default=None, help="path/id of the change-impact report")
    ap.add_argument("--rollback", default=None, help="exact rollback command(s)")
    ap.add_argument("--notes", default=None)
    ap.add_argument("--dry-run", action="store_true", help="print the proposal, do not write the file")
    args = ap.parse_args(argv)

    proposal = build_proposal(args)

    # SAFETY INVARIANT: this tool can only ever emit PROPOSED, auto_promote=False,
    # human_approved=False. Assert it before writing so a future edit can't silently
    # turn the proposer into a promoter.
    assert proposal["status"] == "PROPOSED"
    assert proposal["promotion"]["auto_promote"] is False
    assert proposal["promotion"]["promoted"] is False
    assert proposal["human_approved"] is False

    out = PROPOSALS_DIR / f"{proposal['proposal_id']}.json"
    if args.dry_run:
        print(json.dumps(proposal, indent=2))
        print(f"\n[dry-run] would write {out}", file=sys.stderr)
        return 0

    PROPOSALS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(proposal, indent=2) + "\n")
    print(json.dumps(proposal, indent=2))
    print(f"\nPROPOSED only. Wrote {out}", file=sys.stderr)
    print("Nothing was applied, promoted, or flipped. Promotion requires a reviewed "
          "release record + checklist (and human approval for the human-approval category).",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
