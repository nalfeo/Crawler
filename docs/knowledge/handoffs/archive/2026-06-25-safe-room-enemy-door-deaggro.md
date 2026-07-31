# Handoff — 2026-06-25 safe-room-enemy-door-deaggro

## What Was Done

Fixed enemy AI behavior where mobs could camp the safe-room doorway (reported on seed 665790).

### Root Cause

Enemies still considered the player detectable while the player was in a safe room, so in-range mobs kept pressure at the doorway instead of disengaging. Existing idle wander also lacked a door-proximity preference in this scenario.

### Fix

- In `enemyAISystem`, when `world.playerInSafeRoom` is true, enemies now stop detecting/chasing the player and switch to idle wander behavior.
- Added a door-proximity check (`isNearDoor`) used by idle wander to avoid door-adjacent wander directions when safe-room de-aggro is active.
- Added a conditional wander bias away from the safe-room player only when the sampled wander direction would keep the enemy near blocked/door-adjacent space.
- Added regression tests for:
  - de-aggro + wandering while player is in safe room
  - avoiding door-adjacent wander directions in safe-room context

### Files Changed

- `src/game/enemyAISystem.ts`
- `tests/game/enemy-ai.test.ts`

## Verification

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `parallel_validation` ✅ CodeQL (0 alerts), Code Review comments reviewed

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎
- Verdict: exact

## Systems touched

enemies
