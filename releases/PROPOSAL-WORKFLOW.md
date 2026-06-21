# Self-Update Proposal Workflow (PROPOSAL-ONLY)

How future Jarvis self-improvements move from idea to (maybe) live, with gates,
and with NO autonomous promotion. This is the spec for `tools/release_proposer.py`
and the nightly / weekly cadence around it.

## Principle

Jarvis must NOT freely self-edit production. Self-updates are PROPOSED by the
agent and PROMOTED only through a reviewed release record + checklist. The
proposer writes a proposal and stops. Nothing in the proposal path applies a
change, flips a flag, edits a cron, or touches credentials.

## The flow

```
  (1) agent detects an improvement
        |
        v
  (2) tools/release_proposer.py  --->  releases/proposals/<id>.json   (PROPOSED)
        |                                  status=PROPOSED
        |                                  auto_promote=false
        |                                  human_approved=false
        v
  (3) classification (automatic, cannot be down-classified by caller):
        - touches a protected path?  -> human-approval
        - behavior change?           -> at least weekly-behavior-release
        - else                       -> nightly-safe-update
        |
        v
  (4) reviewer builds a RELEASE RECORD from RELEASE-RECORD-TEMPLATE.json
        runs RELEASE-CHECKLIST.md, attaches change-impact report
        |
        v
  (5) gates: eval/test, independent reviewer (behavior), canary, rollback, notes
        |
        v
  (6) PROMOTION = a human/reviewer action recorded in the record
        (human-approval category additionally needs human_approved=true)
```

The proposer owns steps 1-3 only. Steps 4-6 are human/reviewer actions outside
the proposer.

## Categories

- **nightly-safe-update** - low-risk, no behavior change (docs, inventories,
  registry reconciliation proposals, stale-record fixes). The nightly read-only
  reconciliation (RULES.md) emits proposals of this category. Light reviewer,
  no canary, still promoted via a record. Never auto-applied.

- **weekly-behavior-release** - a behavior change. Requires an independent
  reviewer and a canary before promotion. The weekly cadence batches these for
  review.

- **human-approval** - anything touching money, risk, trading, credentials,
  permissions, live crons, or live prompts. Auto-escalated by the proposer
  whenever a protected path is involved. BLOCKED from promotion until a human
  explicitly approves. The live-config guard additionally blocks any direct
  write to these paths outside an approved record.

## Cadence

- **Nightly:** reconciliation + low-risk proposals are written to
  `releases/proposals/`. They sit there for review. No promotion happens overnight.
- **Weekly:** behavior-release proposals are reviewed, canaried, and (if they
  pass) promoted via records during a reviewed window.
- **Human-approval:** surfaced to B; promotion waits on explicit approval, no
  matter the cadence.

## Guarantees (enforced, not aspirational)

1. `release_proposer.py` has no `--apply` / `--promote` / `--live` path and
   asserts `status=PROPOSED`, `auto_promote=false`, `human_approved=false`
   before writing. It cannot emit a promoted record.
2. A caller cannot down-classify a dangerous change: any protected path forces
   `human-approval`.
3. `live_config_guard.py` BLOCKS direct agent writes to protected live config
   (feature-flags, crons, credentials, money/risk/trading, live prompts,
   permissions) unless an approved release record authorizes it.
4. Promotion is always a recorded human/reviewer action. There is no code path
   that autonomously promotes a proposal to live.

## Usage

```bash
# Propose a docs-only update (nightly-safe-update):
python3 tools/release_proposer.py \
  --change-id inventory-refresh \
  --summary "Refresh components.json inventory from disk scan" \
  --category nightly-safe-update \
  --path system-model/components.json \
  --rollback "git revert <hash>"

# Attempt to propose a flag flip: auto-escalates to human-approval regardless of
# the requested category, because feature-flags.json is a protected path.
python3 tools/release_proposer.py \
  --change-id flip-doctor-goodput \
  --summary "Enable FEATURE_DOCTOR_GOODPUT" \
  --category nightly-safe-update \
  --path orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json \
  --behavior-change
# -> category becomes human-approval; proposal only; no flip happens.
```
