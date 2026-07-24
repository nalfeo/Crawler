# Handoff: Mapgen Special Room Fixes

**Date:** 2026-06-23  
**Persona:** Engineer  
**Apple estimate:** 🍎🍎 (actual: 🍎🍎, verdict: on-target)

## Systems touched

mapgen

## What Was Done

Fixed four mapgen issues across two sessions (the prior session started; this one finished and addressed code review):

### 1. SAFE Rooms Can Be Ellipses

`applyRoomShapes` previously had a full `continue` for SAFE rooms, blocking all shapes. Changed so only L-shapes are blocked for `SAFE` and `BOSS_STAIR` rooms. Ellipses apply to all rooms (they always have a passable center).

File: `src/core/map/generators/DungeonGenerator.ts` — `applyRoomShapes()`

### 2. BOSS_STAIR Perimeter Protection

`sealSpecialRoomPerimeters` and `buildSpecialRoomWalls` previously excluded `BOSS_STAIR` rooms (an old deferred concern). Both now include `BOSS_STAIR` alongside `SAFE`. This ensures diagonal shortcut tunnels can't bypass the boss room walls.

### 3. Items/NPCs Never Spawn in Walls

Added `resolvePassableRoomCenter(floorMap, room)` in `floor1Scenario.ts`. Spirals outward from the bounding-box center within room interior bounds until finding a passable tile. Used for all objective positions: staircase, welcome office, shop, quest item, slime rat room, spell quest giver, and welcome sign placement.

### 4. Sword Seed in Tests

Switched `floor1-main-scene-options.test.ts` from `seed: 42` (gives baseball-bat first) to `seed: 1` (gives sword first).

### 5. Code Review Cleanup

- `resolvePassableRoomCenter` parameter now uses `RoomBounds` type (imported from map-types)
- `maxR` renamed → `maxRadius`
- "centre" → "center" in docstring
- `isSpecial` local variable removed; check inlined into the `else if` branch

## Key Files Changed

- `src/core/map/generators/DungeonGenerator.ts`
- `src/game/floor1Scenario.ts`
- `tests/ecs/map-generators.test.ts`
- `tests/game/floor1-main-scene-options.test.ts`
- `src/scripts/boss-check.ts` (pre-existing lint fix: `any` → `DoorLocation`)

## State

All 677 tests pass. `verify:fast` green. PR ready for review.

## Notes for Next Agent

- `resolvePassableRoomCenter` is currently only used in `floor1Scenario.ts`. If floor 2+ scenarios are added, they should also use this helper (or a shared version) for item/NPC placement.
- L-shape RNG consumption for special rooms mirrors the real `applyLShape` quadrant-selection logic exactly — don't simplify it or you'll desync the stream on existing seeds.
