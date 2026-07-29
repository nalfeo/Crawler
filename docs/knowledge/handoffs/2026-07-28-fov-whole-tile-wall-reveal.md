# Handoff — FOV Whole-Tile Wall Reveal

## Date

2026-07-28

## Systems touched

lighting

## Summary

When FOV reaches a wall, the **entire** wall tile is now revealed and illuminated
instead of only the sub-tiles a shadowcast ray physically landed on. Walls used
to render as ragged, half-lit slabs because FOV runs at `subFactor`× sub-tile
resolution while a wall is opaque across its whole tile: rays could only ever
reach the face nearest the player, leaving the rest of the same tile black.

## Files touched

- `src/core/map/FloorMap.ts`
- `src/core/systems/fovSystem.ts`
- `tests/ecs/fov-system.test.ts`
- `tests/ecs/fov-system-equivalence.test.ts`

## What changed

- Added `FloorMap.markTileVisibleAndDiscovered(tx, ty)` — fills every sub-tile of
  one tile in both the `visible` and `discovered` bitmaps, updates the O(1)
  tile-level caches, and expands the `clearVisibility()` bounding box. Implemented
  as `subFactor` row `fill()`s rather than per-sub-tile setter calls.
- `fovSystem`'s `onVisible` now branches on tile opacity after the corner-seam
  check: opaque tiles route to the whole-tile fill, transparent tiles keep the
  existing per-sub-tile write. Floor boundaries (e.g. the vision-radius ring)
  therefore stay at sub-tile granularity — walls are the only exception.
- The existing per-tile seam memo doubles as the "already expanded this pass"
  flag, so each opaque tile is filled **at most once per FOV pass** and the change
  adds no per-sub-tile work.
- Updated the differential reference in `fov-system-equivalence.test.ts` to
  include the same rule, written naively (nested loop over `setVisible` /
  `setDiscovered`) so it still independently pins the optimized fill path
  byte-for-byte.

## Observe before done (real artifact: the game, `npm run dev`)

- **Before:** ran Floor 1 in the browser; the room's left border wall rendered
  with only a thin lit sliver on its inner face, the rest of the same wall tile
  fully black — a visible seam running down the middle of the wall.
- **After:** same Floor 1 view with the fix loaded (Vite HMR); the border walls
  render as complete, solid, evenly-lit tiles and the lit region is bounded by
  whole wall tiles.

## Verification run

- `npx vitest run tests/ecs/fov-system.test.ts --project unit` ✅ (27 tests)
- `npx vitest run tests/ecs/fov-system-equivalence.test.ts --project unit` ✅ (16 tests)
- `npm run verify:fast` ✅ (1830 unit tests)
- `npm run test:headless` ✅ (157 tests / 26 files) — all Floor-1 win-rate,
  park-watchdog, and completion gates unchanged, confirming the extra visible
  sub-tiles do not perturb the AI's `isVisibleAt` fog-danger scoring.

## Unresolved issues

- None found in the touched scope.

## Notes for the next agent

- `tests/ecs/fov-system-equivalence.test.ts` is a **byte-identical** differential
  pin. Any intentional change to FOV visibility semantics must be mirrored in its
  reference implementation, or every test in that file fails with a giant array
  diff. It is not a bug when that happens — it's the pin doing its job.
- `npm run scope` reports `local-scope: not a git work tree — forcing full-suite`
  inside a Copilot worktree session, so it always fails safe to all-false. Do not
  read its flags as "nothing to run" there.
