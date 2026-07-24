# Session Handoff: Special Room Wall Protection

## Date

2026-06-23

## Persona(s) adopted

Systems Engineer

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎  
Verdict: 🎯 Exact

## What Was Done

### Problem

The `DungeonGenerator` (with `roomVariety: true`) had two related wall-integrity bugs for `SAFE` and `BOSS_STAIR` rooms:

1. **Pre-existing openings (rot-js)** — when two rooms are placed close together, rot-js can route a corridor tile through a position that falls on the 1-tile-padded boundary of an adjacent room's `RoomBounds`. This left passable non-door tiles on the perimeter of special rooms before variety even ran.

2. **Variety post-processing carvings** — `applyRoomShapes` (ellipse + L-shape), `widenCorridors`, and `addDiagonalShortcuts` / `carveBresenhamPath` all carve new floor/corridor tiles out of `STONE_WALL` tiles. They ran on every room without knowing which rooms were special, so special room perimeter walls could be breached and L-shapes could cramp the boss fight area.

### Fix

**`DungeonGenerator.ts`** — three new helpers + two guarded passes:

| Helper                        | Purpose                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preAssignRoles()`            | Assigns SPAWN/BOSS*STAIR/SAFE roles from bounds-centre distances \_before* any tile mutation. Identical distance scoring to the old post-variety assignment.                              |
| `sealSpecialRoomPerimeters()` | After pre-assignment, converts any passable non-door tile on the perimeter of SAFE/BOSS_STAIR rooms to `STONE_WALL`. Fixes pre-existing rot-js corridor tiles on special room boundaries. |
| `buildSpecialRoomWalls()`     | Returns a `ReadonlySet<number>` of all perimeter tile indices for SAFE/BOSS_STAIR rooms.                                                                                                  |

The set returned by `buildSpecialRoomWalls` is threaded through:

- `applyRoomShapes` — now checks `room.role` and skips SAFE/BOSS_STAIR rooms entirely (no ellipse, no L-shape)
- `widenCorridors` — checks `protectedWalls.has(targetIdx)` before adding a tile to the widen set
- `carveBresenhamPath` — checks `protectedWalls.has(idx)` before carving any tile

The old post-variety `setRole` calls were removed; `paintRoomFloor` now reads the pre-assigned role via `getFirstRoomByRole`.

**`tests/ecs/map-generators.test.ts`** — three new tests:

- `should keep SAFE and BOSS_STAIR room perimeter walls intact after room variety` — walks all perimeter tiles of special rooms across 8 seeds and asserts no open non-door corridors remain
- `should assign BOSS_STAIR room the same id before and after room variety` — regression guard ensuring pre-assignment selects the same boss/safe rooms as the old post-variety scoring
- Extracted `REGRESSION_TEST_SEEDS` constant used across all seed-looping tests for maintainability

### Test coverage

All 137 unit tests pass.

## What's Next

- Consider adding a visual debug overlay to `map-gen-lab` highlighting special room perimeters to verify visually across seeds
- The minimum boss room _size_ (at generation time) is now implicitly the rot-js-allocated rectangle; if very small boss rooms become a gameplay issue, add a minimum-area candidate filter in `preAssignRoles`

## Blockers

None.

## Branch State

- All tests passing: ✅
- PR open: yes
