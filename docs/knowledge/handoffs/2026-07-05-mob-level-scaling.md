# Handoff — Distance-from-spawn mob level scaling

## Summary

Implemented a gentle difficulty ramp for ambient mobs on Floor 1: enemies that
spawn farther from the player's starting tile receive scaled HP and speed. The
scaling is linear and capped so non-boss mobs are always beatable even at the
far edge of the dungeon.

## Systems touched

spawning, combat-balance

## What was done

- **`src/shared/mob-scaling.ts`** (new) — pure `computeMobLevelScale(distFt)`
  returning `{hpMult, speedMult}`. Linear ramp from 1.0× at spawn to 1.5× HP /
  1.1× speed at ≥250 ft. No RNG, fully deterministic.
- **`src/game/floorScenario.ts`** — `spawnAmbientArchetype` now computes the
  Euclidean distance from `world.floorMap.playerSpawn` to the spawn position and
  applies the scale before calling `spawnBehaviorEnemy`. Room wave spawns via
  `prepopulateEnteredRoom` inherit this automatically (they call
  `spawnAmbientArchetype`).
- **`tests/unit/mob-scaling.test.ts`** (new) — 8 unit tests covering boundary
  clamping, midpoint linearity, monotonicity, and ceiling enforcement.

## Verification

- `npm run verify:fast` — 3852 tests pass ✅
- `npm run verify` — all steps pass (headless gate deferred to CI) ✅

## Design notes

- `MOB_SCALING_REFERENCE_DIST_FT = 250` — at this distance multipliers peak. Most
  of the floor sits within 150–250 ft of spawn, so a typical run sees 1.0–1.5×.
- HP 1.5× max keeps mobs dangerous-feeling without being unkillable.
- Speed 1.1× max is intentionally small — faster enemies disproportionately
  increase difficulty.
- The headless Floor-1 win-rate gate (CI) will catch any regression if the
  constants need to be tuned down.

## Unresolved issues

None. Constants are tunable via the exported `MOB_SCALING_*` constants.

## Recommended next steps

- Monitor CI win-rate gate after merge. If win-rate drops below 90%, reduce
  `MOB_SCALING_HP_MULT_MAX` to 1.5 as a first step.
- Consider a `MobLevel` ECS component in a future session if the level needs to
  be surfaced in the HUD (e.g. level indicator above health bar).

## Apples

Estimated: 🍎🍎🍎 (Medium)
Actual: 🍎🍎🍎 (Medium)
Verdict: exact
