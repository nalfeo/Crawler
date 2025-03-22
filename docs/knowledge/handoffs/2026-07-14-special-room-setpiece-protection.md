# Handoff: special room + set-piece protection

**Date:** 2026-07-14  
**Persona:** Systems Engineer  
**Systems touched:** mapgen

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact). Small mapgen/scenario bug fix with focused regression coverage.

## What Was Done

- Added a shared `restoreRoomInterior(...)` helper in `src/core/map/special-rooms.ts` that restores a room's full rectangular interior to passable floor tiles.
- Applied that helper in `DungeonGenerator.generate()` after room-variety/cave passes for `SAFE` and `BOSS_STAIR` rooms so reserved rooms no longer keep ellipse/L-shape carve remnants or other interior re-carves.
- Updated Floor 1 welcome-room selection to prefer rooms large enough for the exact `welcome-room` set piece footprint.
- Updated `tagRoomAsSafe(...)` to restore the chosen welcome room's full interior before repainting/sealing it, preventing the L-shaped welcome-room defect from the issue screenshot.
- Added deterministic regressions for:
  - special-room interiors staying fully rectangular under room variety
  - Floor 1 welcome room fitting the exact set-piece footprint with no unexpected carved interior walls
- Re-baselined the dungeon-generator golden snapshot and NAVMESH determinism hash to the intended new deterministic topology.

## Observe Before Done

- **Before:** issue screenshot showed the welcome room retaining an L-shaped carved interior even after it became the Floor 1 safe/set-piece hub.
- **After:** deterministic real-pipeline regression coverage now proves the welcome room chosen by `initializeFloor1Scenario()` has a full reserved footprint for the exact `welcome-room` set piece and no extra carved interior walls; generator-level regressions also prove `SAFE`/`BOSS_STAIR` rooms keep full rectangular interiors.

## Validation

- `npx vitest run tests/ecs/map-generators.test.ts tests/game/floor1-scenario.test.ts`
- `npx vitest run tests/determinism/dungeon-generator-golden.test.ts -u`
- `npm run verify:fast`

## Key Files

- `src/core/map/special-rooms.ts`
- `src/core/map/generators/DungeonGenerator.ts`
- `src/game/floorScenario.ts`
- `tests/ecs/map-generators.test.ts`
- `tests/game/floor1-scenario.test.ts`
- `tests/determinism/navmesh-determinism.test.ts`
- `tests/determinism/__snapshots__/dungeon-generator-golden.test.ts.snap`
