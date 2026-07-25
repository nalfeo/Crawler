# Handoff: terrain-pack wall underdraw fix

**Date:** 2026-07-25  
**Session slug:** terrain-pack-wall-underdraw  
**Apple estimate:** 🍎🍎  
**PR:** fixes #1967  
**Review ledger:** `docs/knowledge/review-ledgers/2026-07-25-terrain-pack-wall-underdraw.review-ledger.json`

## Systems touched

terrain-renderer, terrain-packs

## Problem

In the terrain bake loop (`buildTerrainLayer`), terrain-pack wall tiles stamped
the blob47 wall atlas frame and immediately `continue`d — no floor surface was
stamped underneath. The blob47 silhouette carries real alpha (~37.5% open-edge
quadrants inset by `WALL_INSET_PX = 48` of `QUADRANT_SRC_PX = 128`), so those
transparent regions exposed the empty `RenderTexture` and rendered as pure black
instead of showing ground. Most visible where wall runs border open floor.

## Fix

`src/engine/terrain-renderer.ts` — inside the pack-wall branch
(`PACK_WALL_TERRAIN_TYPES` check), **before** stamping the wall atlas frame, stamp
a floor-pool variant as underdraw:

```
pickPoolVariant(pack.floorPool, floorSeed, tx, ty)
  → guard scene.textures.exists()
  → rt.stamp(underVariant.textureKey, undefined, …, { scaleX: packPoolScale, … })
then:
  rt.stamp(pack.wallAutotile.textureKey, frameIndex, …, { scaleX: packWallScale, … })
  packWallCount++
  continue
```

Key constraints honoured:
- **Deterministic:** uses the same `pickPoolVariant(floorSeed, tx, ty)` hash as
  floor tiles — same seed+position always produces the same underdraw tile.
- **Graceful degradation:** guarded by `scene.textures.exists()`. If floor pool
  textures are not yet loaded (cold boot), the underdraw step is skipped and the
  wall frame still stamps correctly (1 stamp instead of 2).
- **Histogram clean:** underdraw stamp does NOT increment `packFloorCount` — it is
  not a player-visible floor tile and must not pollute floor-diversity metrics.
- **Minimap unaffected:** `HudMinimap` renders its own terrain texture via solid
  color fills per-tile (`rt.fill(color, …)`), not pack stamp calls. No change
  needed there.

## Tests updated

`tests/unit/terrain-pack-renderer.test.ts`:
- Updated 3 existing tests whose stamp-count assertions assumed 1 stamp per wall
  tile (now 2 stamps per wall tile: floor underdraw at `stamps[n*2]`, wall frame
  at `stamps[n*2+1]`).
- Added 3 new tests:
  1. `wall tile underdraw: stamps floor-pool texture first, then wall atlas frame on top`
  2. `wall tile underdraw is deterministic: same seed+position gives same underdraw tile`
  3. `wall tile stamps only wall frame (no underdraw) when floor pool textures are missing`

## Verification notes

This change only affects `src/engine/` (no core, game, or labs changes). CI runs
`terrain-pack-renderer.test.ts` in the unit suite.

Real-scene observe-before-done (deterministic, fixed-seed `MainGameScene` on Floor
2 via `main-scene-probe-lab`, which boots through `createFloorGameConfig` +
`createFloorMainSceneOptions` with `worldSeed=4242`):

- **Before** (temporarily restoring `src/engine/terrain-renderer.ts` from `HEAD~2`,
  then resolving the loadout, pausing the sim, hiding lab chrome, and capturing the
  real canvas): terrain provenance was unchanged
  (`generated=185, sprite=15, color=0, packWall=11509, packFloor=28291,
  packCorridor=0`), but the captured Floor 2 canvas contained many very-dark wall
  notch pixels — for example `(498,245)` and `(573,280)` were `rgba(6,6,6,255)`.
- **After** (current HEAD, same seed and probe steps): provenance counts stayed
  identical, proving the map/layout did not change, while those same pixels became
  floor-colored `rgba(24,20,18,255)` / `rgba(24,19,17,255)`.
- A direct before/after canvas diff changed **22,784** pixels, with **22,351**
  getting brighter and only **427** darker from antialiasing at the wall edge. Of
  the changed pixels whose pre-fix average RGB was below 20, **844** crossed to 20+
  after the fix, matching the expected “black-ish void under transparent wall
  silhouette becomes visible floor art” behavior in the real Floor 2 scene.

No wiring changes — `buildTerrainLayer` is called by `MainGameScene` at
`src/engine/scenes/MainGameScene.ts:2142` unchanged.
