# Handoff — Cave tile readability (biome map visual review)

**Date:** 2026-06-22
**Persona:** Graphics Designer (visual polish on `src/engine/sprites/*`)
**Apples:** estimated 🍎🍎 / actual 🍎🍎🍎 (underestimated; scope grew on follow-up sweep)

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

## Second pass — full oddity sweep ("did you look for others?")

Built a 4×4-tiled swatch of _every_ mapped `TerrainType` (drives the live
`TILE_SPRITES` table in-browser) plus labelled sheet dumps. Additional fixes in
`src/engine/sprites/tile-visuals.ts`:

- **CORRIDOR** (was cobblestone `td(9,4)`/f57) rendered as vertical **"bars"** —
  a portcullis sprite with transparent gutters; visible in-game on floor 1. →
  remapped to clean full-bleed cobblestone `rpg(8,0)`.
- **SAFE_ROOM_FLOOR** (was `td(10,4)`/f58) — same portcullis "bars". → remapped
  to clean pale flagstone `rpg(9,0)` (calm, distinct from room + corridor).
- **LAVA** (was `rpg(49,0)`) was actually a **hanging banner**, not lava (no
  clean lava tile exists in the Kenney sheets). → removed mapping; falls back to
  the deep-red solid in `terrain-colors.ts`, which reads as lava far better.
- **DIRT** (was `tt(3,0)`) was a **mound/prop on a transparent bg** that tiled
  into scattered blobs. → removed mapping; falls back to warm-brown solid.
- **WOOD_FLOOR** (was `tt(8,3)`/f44) was **transparent plank fragments**. →
  removed mapping; falls back to brown solid.

All verified in the live floor-1 game (corridors + safe room now read cleanly)
and the swatch. `npm run verify` passes.

## Remaining recommendations (not done — larger / design calls)

1. **FOREST / FIRE_SWAMP are cave-skinned.** They use `CaveGenerator` and only
   emit `CAVE_FLOOR`/`CAVE_WALL`, so they don't read as forest (grass/trees) or
   fire (lava). Needs generator/biome-theming work, not just frame swaps.
2. **No true room-colour coding.** Boss/safe/corridor distinction is limited by
   the Kenney palette (only warm-tan + a few gray full-bleed floors). Real
   colour-coded floors (red boss / blue safe) need custom tiles or engine tile
   tinting in the terrain renderer.
3. **Lower-priority leftovers:** `WATER` (`rpg(0,0)`) is a little pale; `RUBBLE`
   (`td(2,2)`) reads more like a banded broken wall than floor debris;
   `BOSS_STAIR_FLOOR` (`td(4,4)`) has a slightly busy corner-arc motif. None are
   emitted by a generator yet, so left as-is.
4. When custom art lands, wire real tiles back into the placeholders that now use
   fallback colours (LAVA, DIRT, WOOD_FLOOR).

Screenshots captured during review live in `/tmp/shots/` (session-local).
