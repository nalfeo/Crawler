# Handoff: applyDamage Choke Point

**Date:** 2026-06-05
**Branch:** nalfeo/fix-weapons-lab-damage-indicators

## Summary

Extracted a single `applyDamage(world, target, amount, x, y)` function in `src/core/helpers.ts` that all damage-dealing systems must use. This ensures floating damage numbers (CombatVfx) always appear regardless of damage source.

Previously, only `damageSystem` (projectile/contact hits) emitted `CombatEvent` entries. The `areaDamageSystem`, `beamSystem`, and `meleeSwingSystem` reduced HP directly without emitting events, so melee/beam/AoE/trap weapons never showed damage indicators.

## Files Touched

- `src/core/helpers.ts` -- added `applyDamage()` helper
- `src/core/systems/damageSystem.ts` -- refactored to use `applyDamage`, removed `emitCombatEvent`
- `src/core/systems/areaDamageSystem.ts` -- uses `applyDamage` instead of direct HP write
- `src/core/systems/beamSystem.ts` -- uses `applyDamage` instead of direct HP write
- `src/core/systems/meleeSwingSystem.ts` -- uses `applyDamage` instead of direct HP write

## Verification

- `npx tsc --noEmit` passes
- `npx vitest run` -- 402 tests pass (50 files)
- Merged `nalfeo/combat-hit-indicators` cleanly

## Unresolved Issues

- `damageSystem` is misleadingly named -- it's really collision resolution. A rename to `collisionDamageSystem` or similar would improve clarity.
- No unit test specifically for the `applyDamage` helper itself (tested indirectly via existing system tests).

## Recommended Next Steps

- Add a dedicated unit test for `applyDamage` in `tests/ecs/`
- Consider adding an ESLint rule or architectural boundary check that flags direct `health.current[x] = ...` writes outside of `applyDamage`
- Rename `damageSystem` to better reflect its collision-resolution role
