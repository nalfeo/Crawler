# Handoff: applyDamage Choke Point

**Date:** 2026-06-05
**Branch:** nalfeo/fix-weapons-lab-damage-indicators

## Summary

Extracted a single `applyDamage(world, target, amount, x, y)` function in `src/core/apply-damage.ts` that all damage-dealing systems must use. This ensures floating damage numbers (CombatVfx) always appear regardless of damage source. The function is re-exported from `src/core/helpers.ts` for backward compatibility.

Previously, only `damageSystem` (projectile/contact hits) emitted `CombatEvent` entries. The `areaDamageSystem`, `beamSystem`, and `meleeSwingSystem` reduced HP directly without emitting events, so melee/beam/AoE/trap weapons never showed damage indicators.

## Files Touched

- `src/core/apply-damage.ts` -- new module with `applyDamage()` implementation
- `src/core/helpers.ts` -- re-exports `applyDamage` for backward compatibility
- `src/core/index.ts` -- barrel export for `apply-damage.ts`
- `src/core/systems/damageSystem.ts` -- refactored to use `applyDamage`, removed `emitCombatEvent`
- `src/core/systems/areaDamageSystem.ts` -- uses `applyDamage` instead of direct HP write
- `src/core/systems/beamSystem.ts` -- uses `applyDamage` instead of direct HP write
- `src/core/systems/meleeSwingSystem.ts` -- uses `applyDamage` instead of direct HP write

## Verification

- `npx tsc --noEmit` passes
- `npx vitest run` -- 409+ tests pass (51 files)
- Merged `nalfeo/combat-hit-indicators` cleanly
- Dedicated `applyDamage` tests in `tests/ecs/apply-damage.test.ts`

## Unresolved Issues

- `damageSystem` is misleadingly named -- it's really collision resolution. A rename to `collisionDamageSystem` or similar would improve clarity.

## Recommended Next Steps

- Consider adding an ESLint rule or architectural boundary check that flags direct `health.current[x] = ...` writes outside of `applyDamage`
- Rename `damageSystem` to better reflect its collision-resolution role
