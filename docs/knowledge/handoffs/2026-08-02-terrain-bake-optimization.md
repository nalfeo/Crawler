# Handoff: Terrain Bake Optimization

**Date:** 2026-08-02
**Session slug:** terrain-bake-optimization
**Apple estimate:** 🍎🍎🍎 (actual 🍎🍎🍎)
**Status:** Implementation complete, PR ready for review

## Systems touched

engine, shared

## Task

Follow-up to the boot optimization PR (#2666, `02e9f1f`), whose handoff
(`2026-08-02-startup-perf-optimization.md`) named the terrain bake as the
biggest remaining startup cost: "`buildTerrainLayer()` (33,600 tile stamps into
a 7680×4480 RenderTexture) — not addressed here."

**Bounded goal:** cut `game:terrain-bake` wall-clock on the Floor 1 real bake by
≥50%, with a byte-identical rendered result. Ranked soft tiebreakers: (1) no
visual diff, (2) no new architecture/asset pipeline, (3) preserve all
`TerrainLayerResult` diagnostic counters, (4) preserve determinism.

## Result

**Floor 1 `game:terrain-bake` in the real booted scene: 2113.2ms → 161.9ms
(−92.3%, 13.0×).** Median of 5 boots each, measured via the shipped
`performance.measure('game:terrain-bake', ...)` at `MainGameScene.ts:1069`.

| Metric (Floor 1, seed 42, 240×140 = 33,600 tiles) | Before | After   | Δ      |
| ------------------------------------------------- | ------ | ------- | ------ |
| `game:terrain-bake` wall-clock (real game, median) | 2113.2ms | 161.9ms | −92.3% |
| RT commands (stamp + fill + clear)                 | 80,935 | 37,955  | −53.1% |
| `rt.clear` calls                                   | 23,881 | 0       | −100%  |
| `rt.stamp` calls                                   | 56,967 | 37,868  | −33.5% |
| `scene.textures.exists` queries                    | 57,054 | 27      | −99.9% |

Every `TerrainLayerResult` diagnostic counter is unchanged (`packWallCount`
23,454, `packFloorCount` 8,287, `packCorridorCount` 1,302,
`packSpecialFloorCount` 470, `colorCount` 87). Floor 2 (200×200,
`industrial-cave`): 86,053 → 58,216 commands (−32.3%), 19,104 → 0 clears.

## Why it was slow: not all RT commands cost the same

Phaser 4's `DynamicTexture` buffers draw commands and flushes once at
`rt.render()`. In `DynamicTextureHandler.run`, a `STAMP` batches with its
neighbours into a shared quad batch — but a `CLEAR` does not: it clones the
drawing context, enables and sets a scissor box, issues a `glClear`, and
releases the clone. Every clear therefore **breaks the in-flight quad batch**.

The old bake issued one unconditional full-cell `rt.clear` per wall tile —
23,881 batch breaks on Floor 1. That single line was ~90% of the bake.

## What was done

### Step 1 — clear a cover cell only when there is something to erase

The clear existed to enforce a real invariant documented in the renderer: ground
decals deliberately overhang their tile so walls clip them, and a wall's blob47
frame insets on open edges, so overhanging decal ink inside the inset had to be
erased or it would show through the wall silhouette.

The invariant is now satisfied without the clear in the overwhelmingly common
cases:

- An `inkedCells: Uint8Array` marks each ground-decal stamp's clamped rotated
  AABB (the AABB was already computed for the placement check) plus the
  vertical-overflow rows of a non-square generated/Kenney fallback stamp.
  Linework tiles stay single-cell, so they are never marked. A cover cell that
  was never inked is untouched background — clearing it erases nothing.
- A cell that ends in an **opaque full-cell repaint** needs no clear either,
  because the repaint already destroys the ink. That covers a mask-255 wall
  frame, a successful `floorPool`/`corridorPool`/special-pool underdraw, and the
  `rt.fill` colour fallback.

The clear is now `clearPending` + `clearCellIfPending()`: each branch either
cancels the pending clear (it opaquely repaints) or flushes it before its first
stamp. The conservative branches — generated PNG art, Kenney sheets, and a wall
whose underdraw failed because the texture is missing — still clear. That last
one is the case the original unconditional clear was really protecting.

### Step 2 — drop the wall underdraw when the frame is already opaque

A wall stamps a `floorPool` variant beneath itself so its transparent inset
quadrants show floor rather than bare RT. But an inset only exists on an **open**
edge, so the fully-enclosed mask (`FULLY_OPAQUE_BLOB47_MASK = 255`) has no inset
and needs no underdraw. 81% of Floor 1's walls are mask 255 (bulk rock outside
rooms), because `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` counts `VOID` and the
map edge as solid.

This is an assertion about shipped **art**, not code, so it is pinned against the
real decoded PNGs — see `tests/unit/terrain-pack-frame-opacity.test.ts`.

### Step 3 — hoist per-tile CPU work

- `scene.textures.exists` memoized per bake (57,054 → 27 queries).
- The `PACK_*_TERRAIN_TYPES` `Set.has` chains and `familyForTerrain` replaced by
  a module-level `TERRAIN_FLAGS: Uint8Array(256)` bitfield table **derived from
  the existing `ReadonlySet`s**, so the declarative source of truth stays the
  sets and the two cannot drift.
- Pool and linework stamp configs cached per `(transform, scale)` / `(scale)`
  instead of allocated per stamp.
- Added `computeRawMask8Grid` to `src/shared/terrain-pack-mask.ts`: a
  closure-free variant of `computeRawMask8` over a precomputed solidity grid.
  The old call site allocated a `matches` closure per wall tile and
  `computeRawMask8` allocated two more per call — ~70,000 short-lived closures
  and ~190,000 megamorphic calls per Floor 1 bake to answer what is one typed-
  array read. `computeRawMask8` is unchanged and still used by the pack lab.

**Step 4 (deferred off-camera baking) was not needed and was not implemented.**
Steps 1–3 beat the ≥50% gate by a wide margin, so the change carries no risk of
a camera-pan visual regression and needed no new e2e coverage for it.

## Observe before done (rule #9 — real game, not a lab)

Measured through `loadMainSceneProbeLab`, which boots the **real
`MainGameScene`** through the shipped floor bootstrap, in headless Chromium.

- **Timing:** 5 boots per build, reading the shipped
  `game:terrain-bake-start` / `game:terrain-bake-end` marks.
  Before `[2103.5, 2112.0, 2113.2, 2147.5, 2152.9]` → median **2113.2ms**.
  After `[153.6, 157.4, 161.9, 169.5, 192.0]` → median **161.9ms**.
- **Pixels:** full-viewport screenshots of the real booted scene, before vs
  after, at seed 42.
  - **Floor 1: 0 differing pixels out of 1,440,000 — byte-identical.**
  - Floor 2: 263 differing pixels (0.018%). **Control:** two screenshots of the
    *same* (after) build differ by 257 pixels, so this is pre-existing
    run-to-run sprite-animation jitter, not a bake regression. Terrain itself is
    stable.
- The existing real-scene terrain e2e guards all pass unchanged:
  `terrain-generated-tiles`, `floor2-terrain-variance`, `combat-arena-terrain`.

## Deterministic coverage added

Wall-clock is not a CI-safe gate, so the deterministic gate is **command counts**
plus the art assumptions the optimization rests on.

- `tests/helpers/terrain-bake-harness.ts` — counting RenderTexture + scene stub
  + real Floor 1 / Floor 2 map generation. Shared measurement seam.
- `tests/bench/terrain-bake.bench.ts` — advisory CPU benchmark.
- `tests/unit/terrain-bake-commands.test.ts` — Floor 1/2 clear + stamp budgets,
  exact `TerrainLayerResult` counters, a `textures.exists` bound, and an
  enclosed-vs-inset underdraw regression on a hand-authored 5×5 map.
- `tests/unit/terrain-pack-frame-opacity.test.ts` — decodes every registered
  pack's `wall-atlas.png` and every pool PNG and asserts mask 255 is the **only**
  fully-opaque wall frame and all pool tiles are opaque edge to edge. This is the
  guard that makes Steps 1 and 2 safe against pack re-authoring.
- `tests/unit/terrain-pack-mask.test.ts` — `computeRawMask8Grid` pinned
  exhaustively (all 512 3×3 patterns × both OOB modes, plus a non-square grid)
  against `computeRawMask8` so the bit order cannot drift.

Three pre-existing tests asserted the *old implementation* rather than the
invariant and were rewritten to assert the invariant instead — not weakened:

- `terrain-pack-renderer.test.ts` "paints every wall tile AFTER all decals…" now
  asserts every cover cell is **either cleared or opaquely repainted**, which is
  the actual no-overhang-survives contract.
- `terrain-pack-renderer.test.ts` accent-ordering test now derives whether an
  underdraw is expected from the tile's mask instead of hardcoding one per tile.
- `terrain-pack-floor1-biomes.test.ts` half-tile-anchoring test now uses a
  wall-over-floor fixture so an underdraw exists to locate at all.

## Review findings addressed

- **Plan review (gpt-5.6-sol):** flagged that the two legacy fallback paths
  (generated single PNGs and Kenney sheet frames) derive their scale from source
  **width alone**, so non-square art would render past the bottom of its cell as
  ink the plan did not track. No shipped tile is non-square today, but that is a
  property of the art, not the code. Fixed rather than assumed away:
  `resolveGeneratedScale` now also measures the source height, and
  `markVerticalOverflow()` marks the overflowed rows in `inkedCells`. Covered by
  a regression test that stamps a 256×512 source and asserts the cell below is
  cleared, while the same map with square art clears nothing.
- **Code review (claude-opus-4.6):** flagged that the original clear-path test
  never actually reached `rt.clear()` — its 3×3 map could not satisfy
  `DECAL_MIN_GROUND_FRACTION`, so no decal stamped and the assertion degenerated
  to "the bake produced commands". Replaced with a 16×16 walled-room fixture
  that withholds the wall atlas and floor pools so decals really stamp and the
  cover pass really clears. Verified by mutation: deleting the `rt.clear` call
  now fails two tests.

## Known limitations / next steps

- Node-side CPU for the bake is ~48ms on Floor 1 and barely moved; the win is
  overwhelmingly the GPU-side batch breaks. If more is ever needed,
  `pickPoolCombo` and `normalizeBlob47Mask` are the remaining hot spots.
- Floor 2 still issues 58,177 stamps. The wall-accent second stamp and the
  linework passes dominate there; neither was in scope.
- Still explicitly out of scope: pre-baked terrain atlases shipped as assets,
  splitting the monolithic RT into tiled RTs, and any pack-authoring change.
- The Floor 2 screenshot jitter (~257 px of sprite animation) means a naive
  full-frame pixel-equality e2e would be flaky on Floor 2. Floor 1 is stable and
  would support one if a future session wants that gate.
- CI recovery note: on 2026-08-02, GitHub repeatedly served a stale synthetic
  PR merge snapshot for this branch (`refs/pull/2694/merge`) whose
  `src/shared/data/sprite-catalog.json` still contained 321 committed
  `generated:` rows, even though both the PR head (`refs/pull/2694/head`) and
  the locally rebased branch tree served the cleaned catalog. Each recurrence
  needed a non-empty follow-up commit to force GitHub to recompute the merge
  snapshot against the current branch tree.
