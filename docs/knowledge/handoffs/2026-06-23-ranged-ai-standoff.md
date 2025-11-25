# Handoff — Ranged AI Standoff Behavior

**Date:** 2026-06-23  
**Persona:** Game Designer  
**Apples:** 🍎🍎 (Small) — estimated 🍎🍎, actual 🍎🍎

## Systems touched

ai-combat-balance, weapons

## Summary

The AI runner now maintains a standoff distance for ranged weapons instead of charging directly onto enemies. With a ranged weapon equipped, the AI orbits at **75% of weapon range** rather than walking into melee range.

## What Changed

### `src/game/ai/bt-ai-provider.ts`

Two new constants:

- `RANGED_STANDOFF_FRACTION = 0.75` — desired orbit as a fraction of weapon reach
- `RANGED_APPROACH_BUFFER_PX = 24` — tolerance band around the orbit radius (avoids constant A\* re-planning)

`planEngagement` now branches on weapon type:

- `WeaponType.RANGED` → `planRangedEngagement` (new)
- `WeaponType.MELEE` → existing kite logic (unchanged)
- Others → direct approach (unchanged)

New private methods:

- `planRangedEngagement(world, playerX, playerY, target, reachPx)` — when too far (> standoff + buffer), returns an A\*-navigatable target at the desired orbit distance; otherwise delegates to the orbit step.
- `computeRangedKiteTarget(world, playerX, playerY, target, desiredOrbit)` — mirrors `computeMeleeKiteTarget`: radial correction (away from enemy when too close, nudge closer when too far) + tangential orbit step, wall-aware reversal, periodic flip via shared `kiteOrbitSign`/`kiteSignFrame`.

### `tests/game/behavior-tree-ai.test.ts`

Two new tests:

- _"approaches a distant enemy to 75% weapon range with a ranged weapon"_ — verifies target lands near standoff distance, not at enemy position.
- _"orbits away from enemies closer than ranged standoff distance"_ — verifies retreat direction when enemy is too close.

## Not Changed

- Melee kiting behavior (fully preserved)
- Engage radius (`getEngageRadius`) — determines when to start engaging, not where to stand
- `WeaponType.MAGIC`, `BEAM`, `THROWN`, `TRAP` still use direct approach (same as before; could be tuned later)

## Known Good

`npm run verify` — all 12 tests pass, build succeeds, lint clean.
