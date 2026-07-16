# Handoff: Stairs open on boss death (not after body despawn)

**Date:** 2026-06-25  
**Session:** stairs-open-on-boss-death  
**Persona:** Game Designer  
**Apple estimate:** 🍎 | **Actual:** 🍎 | **Verdict:** exact

## Systems touched

enemies

## Problem

The staircase was only unlocking _after_ the boss body entity was fully removed from ECS (when the death-linger timer expired). Players had to wait through the entire death animation before the stair doors opened.

## Root Cause

`floor1Scenario.ts` line ~1605 checked `entityExists(world.ecs, staircaseEid)` to determine if the boss was alive. But dead entities with `DeathTimer` still exist in ECS during their death animation — they're only removed once the linger timer runs out.

## Fix

Added `!hasComponent(world.ecs, staircaseEid, DeathTimer)` to the "alive" check. `DeathTimer` is added by `dropSystem` the moment HP hits 0, so `staircaseAlive` becomes `false` immediately on the killing blow.

**File changed:** `src/game/floor1Scenario.ts`

- Added `DeathTimer` to component imports
- Updated `staircaseAlive` condition (line ~1608)

## Testing

`npm run verify:fast` — 171 tests, all passed. CodeQL clean.
