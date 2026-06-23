# Handoff: Floor 1 — Basic Underground Expansion

**Date:** 2026-06-21  
**Persona:** Game Designer / Content Designer  
**Apples:** 🍎🍎🍎🍎 (Large) — estimated 🍎🍎🍎🍎, actual 🍎🍎🍎🍎, verdict 🎯 Exact

---

## What Was Done

Implemented all items from the problem statement:

### Config Changes (`src/shared/data/floors/floor1.manifest.json`)

- **Floor size quadrupled**: 120×70 → 240×140 tiles (4× area)
- **Time limit**: 5 min → **10 min** (`durationMs: 600000`)
- **Biome name**: "Floor 1 - Welcome to the Dungeon" → **"Floor 1 - Basic Underground"**
- **Room size range**: `[6,14]×[5,13]` → `[5,22]×[5,18]` (enables much bigger rooms)
- **Max rooms**: 45 → **100**

### New BiomeType (`src/shared/map-types.ts`)

- Added `BASIC_UNDERGROUND = 'basic_underground'` to the `BiomeType` enum

### Generator Registry (`src/core/map/generators/registry.ts`)

- Registered `BiomeType.BASIC_UNDERGROUND` → `new DungeonGenerator({ roomVariety: true })`

### Floor 1 Scenario (`src/game/floor1Scenario.ts`)

- Changed biome from `BiomeType.DUNGEON` → `BiomeType.BASIC_UNDERGROUND`

### DungeonGenerator Enhancements (`src/core/map/generators/DungeonGenerator.ts`)

Added `roomVariety` option (off by default for DUNGEON/CASTLE, on for BASIC_UNDERGROUND):

| Feature                | Implementation                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bigger rooms**       | Config-driven via manifest room size ranges                                                                                                                                                   |
| **Round rooms**        | `applyEllipseShape()` — walls off interior tiles outside inscribed ellipse; ~25% of rooms ≥7×7                                                                                                |
| **L-shaped rooms**     | `applyLShape()` — removes one interior quadrant, scores quadrants by door proximity to keep connectivity; ~25% of rooms ≥7×7                                                                  |
| **Wide corridors**     | `widenCorridors()` — two-pass perpendicular expansion, ~60% of corridor tiles widened by 1 tile                                                                                               |
| **Diagonal shortcuts** | `addDiagonalShortcuts()` + `carveBresenhamPath()` — Bresenham line between diagonally-positioned room pairs; ~30% of rooms get an attempt; 2-tile-wide paths (expand consistently south/east) |

All randomness uses `SeededRandom` (the `rng` parameter, previously ignored). Fully deterministic.

### Tests

- `tests/unit/floor1-config.test.ts`: updated expected values for new size/timer/room ranges
- `tests/ecs/map-generators.test.ts`: added 6-test `BASIC_UNDERGROUND` suite; updated registry test

---

## Key Design Decisions

- `roomVariety` defaults to `false` so existing DUNGEON/CASTLE biomes are unaffected
- Room shaping only touches interior tiles (not boundary where doors live); `ensureDoorAccess()` repairs any door-adjacent tiles that were accidentally walled
- L-shape quadrant selection avoids the quadrant with the most doors
- Bresenham widening uses fixed +south / +east direction (not path-direction-relative) for consistent 2-tile-wide diagonal corridors

---

## Apples

- **Estimated:** 🍎🍎🍎🍎
- **Actual:** 🍎🍎🍎🍎
- **Verdict:** 🎯 Exact
