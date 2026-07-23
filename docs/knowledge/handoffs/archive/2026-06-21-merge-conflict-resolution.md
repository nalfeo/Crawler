# Handoff: Merge conflict resolution + perturbedGoodSword fix

**Date:** 2026-06-21  
**Branch:** copilot/resolve-integration-test-failures  
**Complexity:** 🍎🍎 (two-layer: merge resolution + root-cause bug fix)

## What was done

### 1. Resolved merge conflicts with main

Three files had conflicts after `git merge origin/main`:

- **`scripts/sprites/slice-sheet.ts`** — main already merged a simpler fix
  (PR #165: always use grid-based `sliceSheet` with `rows/cols` from brief).
  Accepted main's version; our V2-fallback approach is superseded.

- **`tests/integration/generate-one.test.ts`** — our branch had a duplicate
  `edge:` sensor block (bug) and used a `1×4` layout; main uses `2×2` with
  `minVariations: 0` and `postprocessing`. Took main's cleaner version and
  updated all `tileVariantsIntoSheet(variants, 1, 4)` calls to `(variants, 2, 2)`.

- **`tests/integration/judge-pipeline.test.ts`** — same `edge:` duplication
  and layout mismatch; resolved identically.

### 2. Fixed pre-existing `perturbedGoodSword` cache-collapse bug

After the merge, `judge-budget-cache.test.ts` had 2 failing tests:
`callCount()` returned 1 instead of 4.

**Root cause:** `perturbedGoodSword` painted 16×16 patches at positions that
fell _between_ the nearest-neighbour sample points of the 1024→32 downscaler.
The sampler reads input pixel `(32·ox+16, 32·oy+16)` for each output pixel,
so patches not centred on those points are invisible at 32×32.  
Additionally the speckle-cleanup step removes isolated near-white pixels
(all channels ≥ 245), so white [255,255,255] patches would have been erased
even if correctly placed.

**Fix:** Replaced the 16×16 patches with 3×3 patches centred precisely on the
four nearest-neighbour sample points that lie on the blade, using black
[0,0,0] (a palette entry, not near-white):

| k   | output pixel | input sample point |
| --- | ------------ | ------------------ |
| 0   | (6, 24)      | (208, 784)         |
| 1   | (9, 21)      | (304, 688)         |
| 2   | (12, 18)     | (400, 592)         |
| 3   | (15, 16)     | (496, 528)         |

All four positions are verified to be inside the blade's 160px-thick
silhouette and well away from image edges. All 25 integration tests pass.

## State left for next agent

- All tests green (25/25 integration, 206 unit).
- PR is ready for CI review.
