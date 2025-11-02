# D1: Deterministic Equipment Generator

**Date:** 2026-07-19  
**Branch:** `copilot/d1-deterministic-equipment-generator`  
**PR:** TBD (targeting `nalfeo-active-weapon-snapshots`)  
**Session:** copilot/d1-deterministic-equipment-generator  
**Apple estimate:** 3🍎

## Systems touched

equipment-generator, generated-equipment-registry, ability-system

## What was done

Implemented the D1 deterministic equipment generator adapted for the main branch API (main has its own squash-merged B1/C1/C2 rather than the stacked branch versions).

### New files

- `src/game/generated-equipment-generator.ts` — core generator: resolves base template → level scaling → rarity scalar → enhancement multiplier → effect budget selection → stat accumulation → frozen payload with `createActiveWeaponSnapshotInput` for weapon snapshots
- `src/game/equipment-ability-grants.ts` — thin wrapper around `grantEquipmentActiveAbility`/`grantEquipmentPassiveAbility`/`revokeEquipmentAbilityGrants` from main's abilitySystem
- `tests/game/generated-equipment-generator.test.ts` — 8 unit tests
- `tests/game/equipment-ability-grants.test.ts` — 4 unit tests
- `tests/property/generated-equipment-generator.property.test.ts` — 3 property tests (determinism, budget, catalog coverage)
- `tests/integration/generated-equipment-runtime.test.ts` — 3 integration tests
- `tests/fixtures/generated-equipment.ts` — shared weapon/armor/accessory request fixtures
- `docs/knowledge/review-ledgers/2026-07-19-d1-deterministic-equipment-generator.review-ledger.json` — 3🍎 review ledger

### Modified files

- `src/shared/generated-equipment-types.ts` — added `ActiveWeaponCombatOverridesV1`, `ActiveWeaponSnapshotCreateInputV1`, `FrozenEquipmentFieldsCreateInputV1`; updated `GeneratedEquipmentCreateInputV1.frozen` to `FrozenEquipmentFieldsCreateInputV1`
- `src/core/generated-equipment-registry.ts` — added `createActiveWeaponSnapshotInput()`, `isActiveWeaponSnapshotCreateInput()`, `buildSnapshotFromCreateInput()`; updated `validateFrozenFields` with `allowDeferredSnapshot` flag (only `validateCreateInput` passes `true`); updated `validateCreateInput` return type to have `frozen: FrozenEquipmentFieldsV1`
- `src/game/index.ts` — exported new generator and ability grant functions

## Key design decisions

1. **Deferred snapshot pattern with `allowDeferredSnapshot` guard**: The generator calls `createActiveWeaponSnapshotInput(weaponDefId, overrides)` which returns a lightweight stub `{weaponDefId, overrides?}`. The registry's `validateFrozenFields` expands this ONLY on the create-input path (flagged `allowDeferredSnapshot=true`). The restore/validate path (`validateGeneratedEquipmentInstanceV1`) uses `allowDeferredSnapshot=false` (the default), which means any deferred stub in a serialized instance is rejected by `validateActiveWeaponSnapshotV1`.

2. **Legacy effect narrowing**: Main's `ResolvedEquipmentEffectV1` union includes `LegacyResolvedEquipmentEffectV1` (no `kind` field). All effect-kind checks use `'kind' in effect && effect.kind === 'stat'` guards.

3. **Main C2 API for ability grants**: Uses `grantEquipmentActiveAbility`/`grantEquipmentPassiveAbility`/`revokeEquipmentAbilityGrants` from main's abilitySystem (not the stacked C2 `grantAbilitySources` approach).

## Acceptance criteria met

- Unit/property tests prove determinism, resolution order, rarity/effect budgets, enhancement bounds, legality, frozen payloads, no static-definition mutation
- Representative fixtures cover weapon, armor, and accessory outputs
- Integration tests prove the weapon fires through the real pipeline and abilities grant/revoke through source tracking
- `npm run verify:fast` passes (1295→1313 tests)
- 3-apple review harness completed: plan review (gpt-5.4, 4 concerns resolved) + code review (claude-sonnet-4.6, 2 concerns resolved); ledger valid

## Remaining for downstream slices

- D2+ save/carryover work (B3)
- Merchant stock, reward integration
- UX, AI behavior
- Unique/above-Rare equipment
