# Handoff — Cave tile readability (biome map visual review)

**Date:** 2026-06-22
**Persona:** Graphics Designer (visual polish on `src/engine/sprites/*`)
**Apples:** estimated 🍎🍎 / actual 🍎🍎 (exact)

## Task

Review the new biome map and placeholder tiles with Playwright + visual AI;
identify issues and tweaks so the maps "make more sense". Specific complaint:
**caves are not obviously caves — you look like you are walking through walls.**

## Method

Ran the lab dev server (`npm run lab`) and the game (`npm run dev`) and drove
Chromium via Playwright to capture screenshots of every biome in
`?lab=tile-render-lab` (actual Kenney frames), the live `BASIC_UNDERGROUND`
floor 1, and the labeled `?lab=tile-explorer` sheet to pick frame indices.

## Root cause (cave)

`CAVE_FLOOR` mapped to Tiny-Dungeon frame 54 (a centred "table/slab" furniture
motif) and `CAVE_WALL` to frame 9 (a block with an interior opening). Both are
small motifs on similar backgrounds, so floor and wall were nearly
indistinguishable — hence "walking through walls". `FOREST` and `FIRE_SWAMP`
reuse the `CaveGenerator`, so they inherited the same problem.

## Change

`src/engine/sprites/tile-visuals.ts`:

- `CAVE_WALL` → frame 0 (`td(0,0)`): a fully-filled dark earthen rock block (no
  interior motif) so it reads unambiguously as a solid, impassable mass; warm
  brown also separates caves from gray cut-stone dungeon walls.
- `CAVE_FLOOR` → frame 53 (`td(5,4)`): a continuous tan cavern floor with light
  pebble speckle — strong value contrast against the wall, no striping.

`src/shared/terrain-colors.ts`: updated the `CAVE_FLOOR` / `CAVE_WALL` fallback
colours to a matching tan/brown so the solid-colour fallback path stays coherent
if the sheet fails to load.

Verified visually in `?lab=tile-render-lab` (cave/fire_swamp/forest now read as
open floor inside solid rock walls). `npm run verify` passes.

## Remaining recommendations (not done — larger / design calls)

1. **Corridors render as vertical "bars".** `CORRIDOR` = cobblestone frame 57;
   in 1-tile-wide vertical runs the horizontal lining reads like blinds. Consider
   a non-directional floor frame for corridors.
2. **FOREST / FIRE_SWAMP are cave-skinned.** They use `CaveGenerator` and only
   emit `CAVE_FLOOR`/`CAVE_WALL`, so they don't read as forest (grass/trees) or
   fire (lava). Needs generator/biome-theming work, not just frame swaps.
3. **Wall/floor value convention.** Dungeon uses a _light_ brick wall + bright
   floor; caves now use the more intuitive _dark solid wall + lighter floor_.
   Worth aligning dungeon walls the same way for consistency later.

Screenshots captured during review live in `/tmp/shots/` (session-local).
