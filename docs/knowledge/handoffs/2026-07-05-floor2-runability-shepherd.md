# Floor 2 Runability — PR #761 Shepherd Handoff

**Session:** floor2-runability-shepherd
**Date:** 2026-07-05
**Branch:** floor2-slice8-scenario-wiring
**PR:** #761
**Persona:** Producer
**Apple estimate:** 🍎🍎🍎 (actual 🍎🍎🍎, on-estimate)
**Status:** ✅ Rebased onto origin/main, all review threads resolved, auto-merge armed (SQUASH)

## Systems touched

mapgen, enemies

## Context

PR #761 ships Floor 2 **visual runability** (exit-staircase marker, floor-completion
screen, `?floor=` query param) on the same branch that PR #721 already squash-merged.
New commits landed after #721's squash, so the PR went DIRTY/CONFLICTING. I took sole
ownership in a worktree to drive it to a clean squash-merge.

## What was done (shepherd)

### 1. Rebase off the already-merged #721 squash

- Verified `git diff 35c3397e 74b4f74d` (branch state #721 captured → #721 squash
  commit) is **empty** — i.e. #721's squash exactly captured the tree at `35c3397e`.
- `git rebase --onto origin/main 35c3397e` replays only the **4 genuinely-new commits**
  (`35c3397e..HEAD`), dropping the 5 that duplicate #721. Clean, no conflicts.
- Sanity: `git diff origin/main...HEAD --stat` = **18 files, +610/−60**, and contains
  **none** of #721's big files (`scenarioDefinitions.ts`, `cave-system.ts`,
  `winrate-sweep.ts`, `headless-runner.ts`, manifests). No re-introduction, no ballooning.
- Backup tag `backup/pre-rebase-761` kept.

### 2. Dead `FLOOR2_STAIR_MARKER_RADIUS_FT` export → WIRED (threads DiN + FUu)

Reviewer flagged the const as exported-but-unused. Resolved on the merits by **wiring it**,
not deleting it, because the staircase feature needs a real interaction radius:

- Hoisted `export const FLOOR2_STAIR_MARKER_RADIUS_FT = 8.0` to `src/shared/constants.ts`
  (engine + game may both import from `shared`).
- `src/engine/scenes/MainGameScene.ts` now imports and consumes it as the **actual**
  staircase interaction radius — marker render (~L2058) and proximity check (~L2474),
  replacing the local `FLOOR2_STAIR_RADIUS_FT`.
- Deleted the dead export from `src/game/floor2Scenario.ts`.
- Added a lockstep drift-guard unit test asserting
  `FLOOR2_STAIR_MARKER_RADIUS_FT === originalFloor2Manifest.objectives.markerRadiusFt`.

### 3. Honest Governor win-rate gate scope (thread DiP — rules #12/#13)

The sweep script had started calling `report.error()` → exit 1 whenever **any** floor's
win-rate `< 0.9`, which dishonestly failed on Floor 2's **expected 0%** (#721's honest
artifact documents Floor 2 as 0%/not-yet-wired at this slice).

- Correct resolution (per coordinator): make the gate **scope** honest — hard-gate **only
  floors that are actually productionised/wired** (Floor 1, ~98.3%); treat not-yet-wired
  floors (Floor 2) as **reported-but-NOT-gating**, with per-floor actuals logged.
- **No weakening**: Floor 1 stays hard-gated at `0.9`. No gameplay/tuning/seed changes.
- `scripts/agent/health/governor-playthroughs.ts` ~L112–128.

### 4. Review harness (3🍎) + valid ledger (thread DiI)

- Ran a separate-model **plan review** (rubber-duck, gpt-5.4) → APPROVE, and a
  **code-review** agent (gpt-5.4) → no concerns / APPROVE. Addressed the one non-blocking
  plan-review suggestion (drift risk) with the lockstep test + toned-down doc comment.
- Recorded the 3🍎 harness in
  `docs/knowledge/review-ledgers/2026-07-05-floor2-runability-shepherd.review-ledger.json`
  (`estimated_apples: 3` with `plan_review` + `code_review` stages). Renamed from the
  original `2026-07-04-floor2-runability` slug so the gating ledger's identity matches this
  shepherd session and pairs with `2026-07-05-floor2-runability-shepherd.json` (both 3🍎),
  leaving the feature session's `2026-07-04-floor2-runability.json` (2🍎) standing alone;
  `npm run review:ledger -- validate` → **valid 3-apple ledger**.

### 5. ADR 0044

Authored `docs/knowledge/adr/0044-floor2-visual-runability-and-honest-governor-gate-scope.md`
for the genuinely-new cross-layer decisions (staircase state, descend flow, completion
detection, shared radius constant + lockstep test, `?floor=` param, floor-state
exclusivity, honest gate scope). Satisfies pr-preflight's cross-system ADR requirement
(0043 is already in main, so not in this delta → needed a new one).

## Observe before done (real artifact, not lab)

- **Real consumer:** `src/engine/scenes/MainGameScene.ts` imports
  `FLOOR2_STAIR_MARKER_RADIUS_FT` from `src/shared/constants.ts` and uses it for the live
  staircase marker + proximity check — the runtime game path, not a lab.
- **Floor-1 win-rate intact:** `VERIFY_FULL=1 npm run verify` ran the ~306s headless
  Floor-1 completion gate → **PASSED** (36/36). The Governor scope change does not touch
  Floor 1's hard gate.

## Validation

- `npm run verify:fast` → green (1218 tests).
- `VERIFY_FULL=1 npm run verify` → typecheck/lint/format/guards/unit/integration +
  headless Floor-1 gate all green; only failed initially on the (now-added) ADR prereq.
- `npm run verify:pr-prereqs` → green (valid 3-apple ledger; preflight satisfied).
- `npm run build` → green (4.14s).

## Merge

- Required checks: `ci` + `commit-lint` only; `enforce_admins:false`; no human review
  required. Armed `gh pr merge 761 --auto --squash` (never `--admin`, never `--force`).
- All 4 copilot-pull-request-reviewer threads (DiI, DiN, FUu, DiP) replied
  `✅ Addressed in <sha>` and owner-resolved via GraphQL `resolveReviewThread`
  (they are `viewerCanResolve:false` for the auto-resolve bot).

## Notes for the next agent

- The two-slice apples files coexist by design: `2026-07-04-floor2-runability.json` (🍎🍎,
  original author) + `2026-07-05-floor2-runability-shepherd.json` (🍎🍎🍎, this shepherd pass).
- Floor 2 remains **0% by design** at this slice (visual runability only; not balance-wired).
  A future slice productionises Floor 2 and then it should be **added to the hard gate**.
- `lab-gate-check.sh` is pathologically slow on Windows Git Bash (~50s/system) and was
  skipped here (delta doesn't touch `src/core/systems/**` or `src/labs/**`).
