# Handoff: Special Room Min Size + Perimeter Integrity

**Date:** 2026-06-24  
**Persona:** Engineer  
**Apple estimate:** 🍎🍎 (actual: 🍎🍎)

## What Was Done

### Two requirements addressed in one PR

**Requirement 1:** Special rooms (BOSS_STAIR, SAFE) must meet a minimum size during generation.

**Requirement 2:** Safe rooms and boss rooms must have only walls and doors around them — no cave tunnel breaches allowed.

### Changes made

**`src/core/map/generators/DungeonGenerator.ts`**

1. `SPECIAL_ROOM_MIN_WIDTH = 9`, `SPECIAL_ROOM_MIN_HEIGHT = 9` — exported constants
2. `DungeonGeneratorOptions.specialRoomMinWidth/Height` — configurable overrides
3. `preAssignRoles` — completely rewritten with:
   - `buildSealSet(roomId)` — computes which perimeter tiles would be sealed for a candidate room (mirrors `sealSpecialRoomPerimeters` logic)
   - `sealingPreservesConnectivity(sealedTiles, extraSealedTiles?)` — flood-fill from spawn treating sealed tiles as walls; returns false if any room's doors become unreachable
   - `pickCandidate(pool, alreadySealedTiles)` — three-tier selection: (1) min-size + connectivity-safe, (2) any-size + connectivity-safe, (3) farthest-regardless fallback
   - SAFE room selection also simulates combined boss+safe sealing via `alreadySealedTiles`

4. The "no breach" requirement is already enforced by the pre-existing:
   - `sealSpecialRoomPerimeters` — seals non-door passable perimeter tiles before variety processing
   - `buildSpecialRoomWalls` + `protectedWalls` — prevents `widenCorridors` and `addDiagonalShortcuts` from carving through perimeters

**`tests/ecs/map-generators.test.ts`** — added 2 new tests:

- `should assign BOSS_STAIR and SAFE rooms that meet minimum size when candidates exist`
- `should still assign BOSS_STAIR and SAFE roles when all rooms are smaller than the minimum`

### Root cause found and fixed

The original bug (interior tiles becoming all-walls) was caused by: when a room with important corridor tiles on its perimeter became BOSS_STAIR, `sealSpecialRoomPerimeters` sealed those corridor tiles, disconnecting other rooms from spawn. `cullIsolatedFloorTiles` then walled all disconnected rooms' interiors. The connectivity-safe selection prevents this by only choosing rooms whose perimeter sealing preserves full dungeon connectivity.

## What Was NOT Done

- Lab for this system change — `DungeonGenerator` already has an existing lab (`mapgen-lab`). This is a bug-fix PR, not a new system.
- No changes to biome registry or floor configs (the 9×9 default is appropriate for floor 1 which has `roomWidthRange: [6,14]`).

## Known State

All 147 tests pass. `npm run verify:fast` green.

## Files Modified

- `src/core/map/generators/DungeonGenerator.ts`
- `tests/ecs/map-generators.test.ts`
