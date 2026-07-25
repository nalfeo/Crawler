# Handoff: terrain-pack wall underdraw fix

**Date:** 2026-07-25  
**Session slug:** terrain-pack-wall-underdraw  
**Apple estimate:** 🍎🍎  
**PR:** fixes #1967  

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
`terrain-pack-renderer.test.ts` in the unit suite. The real behavior is visible in
`MainGameScene` on Floor 2: wall-adjacent cells should now show continuous ground
through silhouette notches instead of black voids.

No wiring changes — `buildTerrainLayer` is called by `MainGameScene` at
`src/engine/scenes/MainGameScene.ts:2142` unchanged.
