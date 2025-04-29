# Handoff: active weapon snapshots main merge recovery

## Date

2026-07-18

## Persona

Producer / Reviewer

## Systems touched

inventory, weapons, ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What changed

- Merged `origin/main` into `copilot/c1-add-immutable-active-weapon-snapshots` to clear PR #1517's merge-conflict blocker.
- Kept the branch's snapshot-capable generated-equipment contracts in:
  - `src/core/generated-equipment-registry.ts`
  - `src/shared/generated-equipment-types.ts`
  - `src/shared/index.ts`
  - `tests/unit/generated-equipment-registry.test.ts`
- Folded in main's newer game-layer resolved-effect compatibility in `src/game/generated-equipment-registry.ts` so structural validation accepts both legacy `units`/`magnitude` effects and current `unitCost`/`value` effect records.
- Tightened the merged shared generated-equipment types back to the runtime contract (`generation`, frozen slots/tags/weight/grants, and `activeWeaponSnapshot` are required) so `main`'s equipment callers typecheck against the snapshot branch again.

## Observe before done

- Before: GitHub reported PR #1517 as `mergeable_state: dirty`, and a local merge produced five conflict files centered on generated-equipment snapshot contracts.
- After: the merge has no unresolved files, the snapshot branch behavior is preserved, there are still no PR review threads to resolve, and the merged tree passes `verify:fast` plus `verify:pr-prereqs`.

## Verification run

- `npx vitest run tests/unit/generated-equipment-registry.test.ts tests/ecs/generated-equipment-registry.test.ts tests/integration/generated-equipment-pipeline.integration.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None.
