# Handoff: D1/C2 TypeScript merge recovery

## Date

2026-07-19

## Persona

Producer

## Systems touched

inventory, weapons

## Apples

Estimated 2🍎, actual 2🍎.

## What changed

- Restored the missing D1/C2 ability grant typing surface in `src/shared/abilities.ts`, splitting `AbilityStateFields` from `AbilityState` and reintroducing the grant-source id/ownership types expected by downstream code.
- Repaired `src/game/systems/abilitySystem.ts` by removing the duplicate exported `equipActiveAbility`, restoring the missing grant validation/helpers/exports, fixing `grantAbilitySources`, and adding `revokeAbilitySources` plus `configureOwnedActiveAbility`.
- Fixed dependent type fallout in `src/core/active-weapon.ts`, `src/core/world.ts`, `src/game/equipment-ability-grants.ts`, `src/game/playerCarryover.ts`, `src/game/systems/skillSystem.ts`, and the affected tests.
- Cleaned two additional pre-existing merge/lint fallouts surfaced by `verify:fast` in `src/game/ai/equipment-evaluator.ts` and `src/labs/equipment-evaluator-lab/index.ts` so the repository is green again.

## Observe before done

- Before: `npx tsc --noEmit` failed with the D1/C2 merge errors around ability grant ownership, duplicate `AbilityState` declarations, missing ability-system exports, and dependent import/narrowing breakage.
- After: `npx tsc --noEmit` exits cleanly and `npm run verify:fast` passes without changing intended runtime behavior.

## Verification run

- `npx tsc --noEmit 2>&1`
- `npx vitest run tests/game/ability-grant-sources.test.ts tests/game/ability-grants.test.ts`
- `npm run verify:fast`

## Unresolved issues

- None.
