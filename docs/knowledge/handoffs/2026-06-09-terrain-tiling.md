# Handoff: Terrain Tiling Foundation

**Date:** 2026-06-09
**Branch:** `nalfeo/terrain-tiling`
**Persona:** graphics-designer / engine

## Summary

Laid the foundational architecture for replacing the solid-color terrain
rendering with real Kenney spritesheet tiles. The main game map was previously
drawn tile-by-tile using `Phaser.GameObjects.Graphics.fillRect()`. This is now
replaced by a `RenderTexture`-based renderer that stamps sprite frames from the
already-loaded Kenney sheets — falling back gracefully to solid colors for
TerrainTypes not yet mapped.

---

## What Was Done

### 1. `src/engine/sprites/tile-visuals.ts` — Tile visual mapping table

New file. Defines:

- `TileVisualDef` interface: `{ sheetKey: string; frame: number }`
- `TILE_SPRITES` — sparse `Partial<Record<TerrainType, TileVisualDef>>`
  mapping dungeon/cave TerrainTypes to Kenney Tiny Dungeon frames
- `getTileVisual(terrain)` helper

Initial frame mappings use `kenney-tiny-dungeon` (12×11 sheet). Frame indices
are labeled "approximate — verify in tile-explorer-lab". The coverage overlay
in the new tile-render-lab makes this easy.

### 2. `src/engine/terrain-renderer.ts` — RenderTexture bake

New file. `buildTerrainLayer(scene, floorMap)`:

- Allocates a `Phaser.GameObjects.RenderTexture` sized to the full floor
- For each tile: if a `TileVisualDef` exists AND the sheet is loaded →
  `rt.stamp(key, frame, x, y, { originX:0, originY:0, scaleX, scaleY })`
  where scale = `tileSizePx / frameWidth` (handles 16→32 upscaling)
- Tiles without a sprite entry → batched into a `Graphics` draw (grouped by
  color to minimize `fillStyle` calls), then `rt.draw(g)` in one pass
- Returns `{ rt, spriteCount, colorCount }` for diagnostics

This gives O(1) per-frame render cost regardless of map size (single GPU
surface after bake).

### 3. `src/engine/scenes/MainGameScene.ts` — Wired to new renderer

- Replaced `private mapGraphics` with `private mapRt` (RenderTexture)
- `drawFloorTerrain()` now calls `buildTerrainLayer(this, floorMap)`
  and logs `colorCount` if any tiles used the fallback path
- Shutdown handler destroys `mapRt` instead of `mapGraphics`
- Removed the now-redundant `TERRAIN_COLORS` table and `TerrainType` import

### 4. `src/labs/tile-render-lab/` — Canvas-based tuning lab

New lab (`?lab=tile-render-lab`). Renders a generated FloorMap using the same
`TILE_SPRITES` table but via plain `<canvas>` `drawImage()` — no Phaser needed
in the lab. Features:

- Biome / seed / size controls
- **Coverage overlay** (green = sprite tile, red = color fallback)
- Shows sprite % coverage in the stats bar
- Links to `tile-explorer` lab for finding frame indices

### 5. `src/lab-main.ts` — `tile-render-lab` registered

---

## What's Next

### Immediate: verify frame indices

Open `?lab=tile-render-lab` with Coverage Overlay ON. The red tiles are
TerrainTypes still on fallback. Cross-reference with `?lab=tile-explorer`
(select `kenney-tiny-dungeon`) to find the correct frames, then update
`TILE_SPRITES` in `src/engine/sprites/tile-visuals.ts`.

Current initial guesses (row×col in tiny-dungeon):
| TerrainType | Frame | Notes |
|---------------|-------|-------|
| STONE_FLOOR | 12 (r1,c0) | Verify in tile-explorer |
| STONE_WALL | 0 (r0,c0) | Verify in tile-explorer |
| CORRIDOR | 13 (r1,c1) | Verify in tile-explorer |
| DOOR | 14 (r1,c2) | Verify in tile-explorer |
| CAVE_FLOOR | 24 (r2,c0) | Verify in tile-explorer |
| CAVE_WALL | 25 (r2,c1) | Verify in tile-explorer |
| RUBBLE | 26 (r2,c2) | Verify in tile-explorer |

### Near-term improvements

1. **Biome-aware palettes** — DUNGEON biome uses `kenney-tiny-dungeon`;
   CAVE might use `kenney-roguelike-rpg-pack` which has more varied cave tiles
2. **Variation via RNG** — stone floors can cycle through 2-3 frame variants
   using the floor's `config.seed` to break visual repetition
3. **Wall autotiling** — detect neighbour walls and pick directional wall
   sprites (N/S/E/W faces) for correct corner/edge appearances
4. **WATER, LAVA, GRASS, DIRT** mappings — `kenney-tiny-town` and
   `kenney-roguelike-rpg-pack` both have outdoor terrain tiles
5. **Progressive bake** — for very large maps (>200×200) consider chunked
   baking across multiple frames to avoid a single-frame hitch at floor load

---

## Files Changed

- `src/engine/sprites/tile-visuals.ts` — **new**
- `src/engine/sprites/index.ts` — re-exports `getTileVisual`, `TileVisualDef`, `TILE_SPRITES`
- `src/engine/terrain-renderer.ts` — **new**
- `src/engine/scenes/MainGameScene.ts` — replaced map rendering
- `src/labs/tile-render-lab/index.ts` — **new**
- `src/labs/tile-render-lab/README.md` — **new**
- `src/lab-main.ts` — registered `tile-render-lab`
