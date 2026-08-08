# Handoff: Slicer cuts only at real gutters — data-driven grid salvage (never chop art)

**Date:** 2026-07-08
**Session:** slicer-never-cut-art (branch `nalfeo-f1-asset-burndown-f2-art`)
**Apple estimate:** 🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎 | **Verdict:** exact
**ADR:** 0052 · **Review ledger:** `docs/knowledge/review-ledgers/2026-07-08-slicer-never-cut-art.review-ledger.json` (valid 4🍎)

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Fixes the maintainer bug report **"the slicer is chopping things off on the right
side a lot."** The 2026-07-07 grid-reconciliation (ledger-only, no ADR) forced the
slicer to emit the brief's commanded cell count; when the model drew fewer
columns/rows than commanded, its **under-segmentation → blind uniform-cut fallback**
invented cut lines with no real gutter, severing edge art. Chosen fix (human
directive): **Option A — SALVAGE.** The slicer now cuts **only at real detected
gutters, never invents a cut**, trims runt edge cells, picks the cut subset that
maximises same-sized sprites, and carries the honest **data-driven** grid/count to
human gallery review. Reverses the force-count half of 0707; **keeps** its
`selectEvenCuts` variance DP and its "gallery review is the grid gate" posture.

## What changed (committed)

- **`scripts/sprites/slice-sheet.ts`** — new per-axis `chooseAxisCuts`:
  `trimEdgeRunts` (drop incomplete partial edge sprites) → search only
  `k ≤ detected` cut counts → `betterAxisScore` order: regular-cell-count DESC →
  `|cells − commanded|` ASC (brief as **soft** anchor) → dispersion ASC → cells
  DESC. New exported `BriefSliceResult { cells, grid{rows,cols,emptyCells},
variantCount }` from `sliceSheetFromBrief` / `sliceSheetWithGrid`. **The bare
  `computeSliceMap` (no `expectedGrid`) path — `/api/slice-map` + gallery — is
  byte-identical** (ADR 0018 single-path guarantee upheld).
- **`scripts/sprites/generate-one.ts`** — count gate relaxed from
  `cells.length === variantCount(brief)` to `cells.length === 0`; persists the
  **actual** `grid`/`variantCount` in the run summary.
- **`scripts/sprites/rerun.ts`** — re-post-process carry-forward guard (ADR 0024)
  re-based on the run's **persisted actual grid**: modern runs re-slice with
  `sliceSheetWithGrid` and compare rows/cols/emptyCells; legacy runs fall back to
  `sliceSheetFromBrief` + variant-count check, then **backfill `summary.grid`**.
- **`run-artifacts.ts` / `provider/types.ts`** — grid persistence + comment/doc.
- Tests: `tests/unit/sprites/slice-sheet.test.ts` (31/31), rewrote 2→3 tests in
  `tests/integration/sprites/rerun.test.ts` (persisted-grid guard: modern reject /
  legacy reject / positive no-op), `.cells` destructure in
  `local-a1111-provider.test.ts`.
- Docs: **ADR 0052** + README row; this handoff; apples metric; **review ledger**.

Two commits on the branch: `d136b79a` (the 8-file implementation the code review
ran against) + a follow-up commit carrying the clarity comment + all docs/ledger.

## Observe-before-done (deterministic, no lab needed — build-time tooling only)

- **Root-cause proof on the real artifact:** integer pixel probe on
  `welcome-room-shop-table-v2` (brief had no `generation.sheet` → defaulted 4×4;
  model drew 5×3). Forced 4-col split = **1806 foreground pixels on interior cut
  lines**; content-aware honest 5×3 = **0**. The unit suite locks this as the
  "shop-table bug" fixture (drops the 12px runt right column, 0 fg-on-cuts).
- **Blast radius green:** the 3 test files that import the slicer all pass — unit
  31/31, `rerun`+`local-a1111` 28/28, `sidecar-rerun`+`generate-one` 21/21.
  `verify:fast` green after the clarity comment.

## Review harness (4🍎, ledger valid)

- **plan_review** (adversarial, gpt-5.5): 4 alternatives argued, 8 concerns (3
  blocking) all resolved before code. **dual_plan_synthesis**: gpt-5.4 + gemini,
  opus judge.
- **code_review + multi_model_review**: 3 distinct models
  (claude-sonnet-4.6, gpt-5.3-codex, gemini-3.1-pro) vs `git diff HEAD~1 HEAD`.
  2 clean; **1 concern** (gemini: `isEdgeRunt`'s `phantomHalf` protects tiny runts
  next to full neighbours). **Adjudicator gpt-5.4 (xhigh) ruled it INVALID /
  low-severity**: it never cuts _through_ art (cuts stay at real gutters); blast
  radius is only the L672 `[10,30,40,40]` keep-test; adopting the fix would **drop**
  ambiguous edge art, contradicting the never-drop-art directive (rule #12/#13).
  Resolved with a **non-behavioral clarity comment** on `isEdgeRunt` documenting the
  deliberate conservative KEEP bias — logic unchanged.

## Key learnings (carry forward)

1. **The guard's residual failure mode flipped from "chops art" to "occasionally
   merges two touching sprites."** If content-aware detection misses a real gutter
   (sprites touching, no background band), the slicer under-counts rather than
   inventing a cut. That is the intended trade — human gallery catches a merged
   cell; it must never re-introduce an invented cut to "fix" it.
2. **`phantomHalf` is a broad conservative KEEP guard, not a precise 0.5/0.5
   half-detector** — future reviewers will re-raise this; the L279-282 + isEdgeRunt
   comments (and this handoff) explain why keeping an ambiguous edge cell is correct.
3. **Legacy re-run migration is expected & safe:** runs generated under 0707's
   force-count may now fail re-post-process with `variant-count-mismatch` (legacy
   fallback) instead of silently overwriting wrong entries — operator regenerates;
   the on-success `summary.grid` backfill makes it bite only once.
4. **Never `git add -A` in this worktree** — untracked `briefs/**` (F2 program) +
   scratch files live here. Stage explicit paths only.

## Next steps (mine, per orchestrator `d467a72d`)

1. Report the slicer PR to the orchestrator; arm `--auto --squash` per policy.
2. **After the slicer merges:** resume **w2 tiles** (the single-PNG tile-stamp
   engine change in `terrain-renderer.ts` `buildTerrainLayer`; 5 tile keys already
   on main; full 3🍎 harness + lab + deterministic pixel/headless probe + observe
   in the REAL game/headless, not just the lab).
3. **Then F2 boss generation** (raccoon-boss + imp-boss) — sequenced after the
   slicer lands (no point generating on a slicer that chops); post sheets INLINE,
   **do NOT auto-merge** (character art → human eyeball).
