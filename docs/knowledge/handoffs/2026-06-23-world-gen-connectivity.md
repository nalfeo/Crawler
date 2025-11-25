# Session Handoff: World Gen Connectivity Fix

## Date

2026-06-23

## Persona(s) adopted

Producer (default)

## Apples

Estimated: 🍎  
Actual: 🍎  
Verdict: 🎯 Exact

## Systems touched

mapgen

## What Was Done

### Problem

Floor 1 (`BASIC_UNDERGROUND` biome → `DungeonGenerator({ roomVariety: true })`) could
produce isolated floor-tile pockets after room-shape post-processing. The three
post-processing passes — ellipse/L-shaped rooms, corridor widening, and diagonal
shortcuts — can all carve or add tiles that end up disconnected from the main
reachable area. These tiles were never reachable by the player or enemies,
violating the design rule "no unpathable spots on floor 1 except the boss room
before its door unlocks."

### Fix

Added `cullIsolatedFloorTiles()` at the end of `DungeonGenerator.generate()`, after
all post-processing and role assignment. It does a single flood-fill from `playerSpawn`
treating PASSABLE tiles **and** DOOR tiles as walkable (so the boss room — which is
behind a closed door — is included in the reachable set). Any passable non-door tile
not reached is converted to `STONE_WALL`.

**Files changed:**

- `src/core/map/generators/DungeonGenerator.ts` — new `cullIsolatedFloorTiles()` helper, called just before `return new FloorMap(…)`
- `tests/ecs/map-generators.test.ts` — new regression test covering floor1-sized maps across 8 seeds; also added `reachableTileIndices()` helper

### Test coverage

All 134 unit tests pass. The new test exercises seed 1, 2, 3, 5, 7, 10, 42, 99 at
120×70 tiles (real floor 1 dimensions) and asserts zero isolated passable tiles after
generation.

## What's Next

- Other world-gen issues (e.g. room role distribution, NPC placement in awkward rooms)
- Consider adding an optional debug overlay in the map-gen-lab that highlights isolated
  tiles before/after the cull pass for visual verification

## Blockers

None.

## Branch State

- All tests passing: ✅
- PR open: yes
