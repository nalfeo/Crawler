# Handoff — 2026-06-25 rat-tail-deadlock-fix

## What Was Done

Fixed seed 665790 timing out due to an unresolvable quest deadlock.

### Root Cause

For seed 665790, room 11 (chosen as the rat-tail fetch item room) had only one
neighbor in the room graph: room 1 (the boss staircase room). The boss staircase
room is **locked** until all three floor-1 quests are complete — including the
shopkeeper errand quest, which requires picking up the rat tail from room 11.
This created a circular dependency: the player needed the rat tail to unlock the
boss room, but the rat tail was only accessible through the locked boss room.
The floor always timed out with `stair_timeout`.

### Fix

In `chooseObjectiveTiles` (`src/game/floor1Scenario.ts`), added a BFS from the
spawn room that treats the boss staircase room as an impassable wall. The
resulting `roomsReachableWithoutBossRoom` set is used to filter the candidate
room list, so quest items and NPCs are never placed in rooms that are exclusively
behind the locked boss-room doors.

### Files Changed

- `src/game/floor1Scenario.ts` — BFS reachability filter in `chooseObjectiveTiles`; added `type RoomData` import
- `tests/game/floor1-scenario.test.ts` — new regression test: seed 665790 rat tail accessible without boss room

## Apples

- Estimated: 🍎🍎 (Small)
- Actual: 🍎🍎 (Small) — 2 files, targeted bug fix + test
- Verdict: exact

## Verification

`npm run verify:fast` — 114 unit tests pass  
`npm run verify` (full suite) — 1686 tests pass
