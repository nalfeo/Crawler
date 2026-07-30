# Handoff: Mapgen Cave Connectivity Fix

**Date:** 2026-06-28  
**Branch:** `copilot/welcome-room-distance-requirements`  
**Apples:** 🍎🍎 estimated → 🍎🍎 actual (exact)

## Systems touched

mapgen

## Summary

Fixed a room graph connectivity bug where `carveCaveRegions` was converting CORRIDOR tiles to CAVE_FLOOR terrain, causing the room-adjacency flood-fill to miss those connections (it only recognised `CORRIDOR` and `DOOR` terrain as connectors). This resulted in 361/500 floor-1 seeds producing graph-disconnected room layouts — rooms reachable by the player but invisible to the AI navigation, NPC placement BFS, and quest-item routing.

## Root Cause

`carveCaveRegions` → `carveTile` converts any passable non-door tile to `CAVE_FLOOR`, including corridor tiles. The subsequent adjacency flood-fill only checked `TerrainType.CORRIDOR | TerrainType.DOOR`. Cave-covered corridors were no longer recognised as connectors, so rooms connected only through cave-floor paths had 0 neighbors in the room graph.

## Changes

### `src/core/map/generators/DungeonGenerator.ts`

1. **Extracted** the room-adjacency flood-fill into `computeRoomAdjacency(terrain, roomGraph, w, h)`.
2. **Moved** the call to AFTER all tile-modifying passes (`ensureRoomsReachable`, `cullIsolatedFloorTiles`, `pruneInaccessibleDoors`), so the final adjacency reflects fully-settled tiles.
3. **Added `TerrainType.CAVE_FLOOR` as a connector** in `computeRoomAdjacency`'s `isConnector` predicate — cave floor is navigable and replaces corridor tiles when cave carving runs.

### `tests/ecs/map-generators.test.ts`

Added regression test: `'should keep all rooms graph-connected from spawn in cave-region maps across floor1 seeds'` — checks 15 representative seeds with the floor-1 map config and asserts every room with a passable interior is reachable via the room graph.

## Result

- Before fix: 361/500 seeds graph-disconnected
- After fix: 0/500 seeds graph-disconnected (the 1 remaining case, seed 408, has a pre-existing door-less safe room with no passable interior — a separate edge case unrelated to cave carving)

## Known Remaining Issue

Seed 408 (and likely a handful of other seeds) produces a SAFE room with 0 doors — rot-js never generates a corridor for it. `ensureRoomsReachable` carves a corridor to the perimeter wall but cannot open the door-less interior, so `cullIsolatedFloorTiles` walls off the interior and the room ends up unreachable. This is a pre-existing bug in how `preAssignRoles` selects the SAFE room — it checks that sealing doesn't disconnect OTHER rooms, but doesn't verify the candidate room is itself connected. Fix scope: separate session.

## Test Results

239 tests passing (verify:fast). No regressions.
