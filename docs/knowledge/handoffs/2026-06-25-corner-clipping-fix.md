# Handoff — 2026-06-25 corner-clipping-fix

## What Was Done

Fixed diagonal corner clipping in core movement so entities cannot pass through a blocked corner where both adjacent orthogonal tiles are walls.

### Root Cause

`movementSystem` allowed diagonal movement whenever the destination tile was passable. In an `OX / XO` layout, this let movement jump diagonally between two open tiles even though both orthogonal routes were blocked.

### Fix

In `/home/runner/work/Crawler/Crawler/src/core/systems/movementSystem.ts`:

- Added diagonal corner-cross detection by comparing old/new tile coordinates.
- Reused axis passability checks (`newX, oldY` and `oldX, newY`).
- Blocked full diagonal movement when both axis checks are blocked.
- Kept existing wall-slide behavior when at least one axis remains passable.

In `/home/runner/work/Crawler/Crawler/tests/ecs/movement.test.ts`:

- Added a dedicated diagonal-corner map fixture.
- Added regression test asserting movement is blocked for the `OX / XO` corner case.

## Files Changed

- `src/core/systems/movementSystem.ts`
- `tests/ecs/movement.test.ts`

## Apples

- Estimated: 🍎🍎 (Small)
- Actual: 🍎🍎 (Small)
- Verdict: exact
- Hello kitties: 0.40

## Verification

- `npx vitest run tests/ecs/movement.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅

## Blockers

- None.
