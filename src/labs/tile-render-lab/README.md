# Tile Render Lab

**URL**: `?lab=tile-render-lab`  
**Category**: Meta

## Purpose

Visual sandbox for tuning the `TerrainType → spritesheet frame` mapping in
`src/engine/sprites/tile-visuals.ts`. Lets developers confirm which tiles have
sprite coverage and which are still using the solid-color fallback, without
running the full game.

## Controls

| Control          | Purpose                                    |
| ---------------- | ------------------------------------------ |
| Biome            | Generator algorithm (dungeon, cave, arena) |
| Seed             | Deterministic map seed                     |
| Width / Height   | Preview map dimensions                     |
| Cell Size        | Zoom level (2–24 px per tile)              |
| Coverage Overlay | Green = sprite tile, Red = color fallback  |
| Show Grid        | Tile boundary lines                        |
| 🎲 Random Seed   | Quick re-roll for variety                  |

## Workflow

1. Open the lab: `npm run lab` → `?lab=tile-render-lab`
2. Enable **Coverage Overlay** to see which tiles need entries
3. Switch to `?lab=tile-explorer` and select the `kenney-tiny-dungeon` sheet
   to browse frame indices visually
4. Add entries to `TILE_SPRITES` in `src/engine/sprites/tile-visuals.ts`
5. Return to this lab and verify the coverage improved

## How Tile Sprites Work

Each `TerrainType` can optionally map to a `{ sheetKey, frame }` pair in
`TILE_SPRITES`. The main game renders these via a single `RenderTexture` baked
once at floor load — all tile stamps happen in one pass, giving O(1) per-frame
render cost regardless of map size.

Tiles without a `TILE_SPRITES` entry fall back to a solid color drawn via a
batched `Graphics` call. The intent is to iteratively migrate TerrainTypes to
real sprites as assets are verified.

## Related Files

- `src/engine/sprites/tile-visuals.ts` — tile visual mapping table
- `src/engine/terrain-renderer.ts` — `buildTerrainLayer()` implementation
- `src/labs/tile-explorer-lab/` — browse spritesheet frames by index
- `src/labs/map-gen-lab/` — procedural generation without tile sprites
