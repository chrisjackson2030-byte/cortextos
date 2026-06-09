# Upstream security sync — 3 fixes: diffs + overlap analysis + safe apply plan (2026-06-08)

Task: get the 3 upstream `fix(security):` commits onto the LIVE path (fleet runs from snapshot branch +
77 uncommitted files, NOT main). RECON/ANALYSIS only — **live tree NOT touched**; apply with Jarvis on his go.
Uncommitted state preserved: git tag `sync-safety-snapshot-20260608` (= stash-create d3fc2c7), recoverable.

## The 3 security fixes (diffs saved as patches in this dir)
| Commit | Fix | Files (src) | Nature |
|---|---|---|---|
| **6fed1eb** | quote Unicode-whitespace-led forged headers in `sanitizeForPtyInjection` | src/utils/validate.ts | additive input-sanitization (defensive; no behavior change) |
| **968d722** | validate task ids + assignee before path construction (path-traversal guard) | src/bus/save-output.ts, src/bus/task.ts, src/cli/bus.ts, src/utils/validate.ts | adds `validateTaskId()` guards before building task-file paths |
| **a52ff26** | sanitize remaining PTY-injection media paths (dynamic-fence regex) | src/daemon/fast-checker.ts, src/pty/codex-app-server-pty.ts | tightens caption/transcript fence regex in `buildMediaPayload` |

All 3 are DEFENSIVE input-validation hardening — they tighten sanitization, they do NOT change trading
logic, kill-switch/halt, daemon scheduling, or telegram behavior. (Verified by reading each hunk.)

## Live-overlap analysis (per file, vs our 77 uncommitted customizations)
| File | Live-modified? | Overlap w/ our code | git apply --check vs LIVE |
|---|---|---|---|
| src/bus/save-output.ts | no | none | **CLEAN ✓** |
| src/bus/task.ts | no | none | **CLEAN ✓** |
| src/daemon/fast-checker.ts | no | none | **CLEAN ✓** |
| src/utils/validate.ts | no | none | 968d722 part CLEAN ✓ ; 6fed1eb part needs light surgical (live base context shifted) |
| **src/cli/bus.ts** | YES | DIFFERENT REGION | needs surgical (see below) |
| **src/pty/codex-app-server-pty.ts** | YES (our FIX#2) | DIFFERENT REGION | **CLEAN ✓ even with FIX#2 present** |

### Overlap 1 — src/cli/bus.ts (968d722) — NO TRUE CONFLICT
- Security change: (a) adds `validateTaskId` to the `../utils/validate.js` import; (b) adds one
  `validateTaskId(taskId);` line at the top of `checkDeliverableRequirement()`.
- Our uncommitted edit: adds a DIFFERENT import (`checkHooksForBlock` from `../bus/hooks.js`) + a NEW
  function `checkCitationVerification()` (W-GATE-1). Different functions/lines.
- → Co-applicable. Only the shared IMPORT block makes `git apply` need a 3-way: trivial surgical fix =
  add `validateTaskId` to the existing validate import (1 token) + paste the `validateTaskId(taskId);`
  line into `checkDeliverableRequirement`. Our hooks import + citation function are untouched.

### Overlap 2 — src/pty/codex-app-server-pty.ts (a52ff26) — NO TRUE CONFLICT
- Security change: `buildMediaPayload()` (~line 319) — caption/transcript regex from fixed ``` to
  dynamic-sized fences (`` `{3,} `` + backreference). 
- Our FIX#2: adds `model` param at thread/start, turn/start, thread/resume (~lines 483-558) — ~150+
  lines away, different methods. → `git apply --check` is CLEAN with our FIX#2 in place. Apply as-is.

## SAFE APPLY PLAN (execute WITH Jarvis, on his go — not before)
1. **4 clean files** (`git apply --check` passes vs live): `save-output.ts`, `task.ts`, `fast-checker.ts`,
   `codex-app-server-pty.ts` → `git apply` the per-file security hunks directly. (codex-pty preserves FIX#2.)
2. **validate.ts**: apply 968d722's validate hunk (clean) + surgically add 6fed1eb's forged-header
   quoting in `sanitizeForPtyInjection` (additive; place by hand since live context shifted).
3. **cli/bus.ts**: surgical — add `validateTaskId` to the validate import + the one guard line in
   `checkDeliverableRequirement`; leave our hooks import + `checkCitationVerification` untouched.
4. After apply: `npm run build` + `npm test` must be green; diff-verify our customizations (FIX#2 model
   params, citation gate, hooks, kill-switch/halt, trading integrations) all intact.

## Risk read
- LOW risk to the live system: defensive sanitization only, no trading-logic/kill-switch/daemon-behavior
  change; both overlaps are different-region (our code preserved); 4/6 hunks clean-apply, 2 need trivial
  surgical. NO auto-resolution done. Live tree untouched. Build+test gate before any commit.
- The deeper structural risk (live fleet on 77 uncommitted files, snapshot branch divergent from main)
  is flagged to B separately by Jarvis — recommend a commit-to-branch of the live customizations soon.

## ⚠️ CORRECTION (apply attempted 2026-06-08, then REVERTED) — symbol-resolution breakage
`git apply --check` matched text context but does NOT verify symbol resolution. On actual apply + `tsc --noEmit`:
- **a52ff26 + 6fed1eb are BLOCKED**: a52ff26 rewrites fast-checker.ts media sanitization to call
  `sanitizeForPtyInjection()` + `wrapFenceSafe()` — functions that DO NOT EXIST in our snapshot's
  src/utils/validate.ts (it only has `stripControlChars`). tsc: 9× "Cannot find name". 6fed1eb HARDENS
  `sanitizeForPtyInjection` — which we don't have. These 2 fixes are part of a larger upstream
  PTY-sanitization subsystem our snapshot PREDATES → cannot be cherry-picked standalone. They require
  PORTING `sanitizeForPtyInjection` + `wrapFenceSafe` (+ deps) into validate.ts (changes fast-checker
  behavior; own review+test pass).
- **968d722 (task-id path-traversal guard): SAFE standalone** — self-contained (`validateTaskId`),
  applied clean, build green. Applicable alone.
- REVERTED all 6 touched files from sync-safety-snapshot d3fc2c7 (diff vs snapshot = 0; FIX#2 4×,
  citation fn 2× intact; tsc baseline = 2 pre-existing errors only; tsup build green). Nothing pushed.
- (Pre-existing tsc errors in our snapshot, NOT from this: cli/bus.ts:468 Event type, agent-process.ts:178 number|null.)
- Recommendation: apply 968d722 alone now, OR port the PTY-sanitization subsystem under review, OR
  prioritize the structural fix (live snapshot missing an upstream subsystem ⇒ commit-to-branch + real sync).
