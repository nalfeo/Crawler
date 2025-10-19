# Handoff: C2 — Source-Owned Equipment Ability Grants

**Date:** 2026-07-18  
**Session slug:** c2-ability-grant-sources  
**Apple estimate / actual:** 3🍎 / 3🍎  
**Branch:** `nalfeo-c2-ability-grant-sources` (stacked on `nalfeo-generated-instance-registry` / B1)  
**PR:** #1393 (ready for review, no auto-merge per issue instructions)

## Systems touched

abilities, equipment, player-carryover, skills

## What changed

### New types — `src/shared/abilities.ts`

- `AbilityGrantSource` discriminated union: `{ kind: 'learned' } | { kind: 'skill'; skillId: string } | { kind: 'equipment'; instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId }`
- `AbilityState` gained two new `Map` fields: `activeAbilityGrantSources` and `passiveAbilityGrantSources`

### Core implementation — `src/game/systems/abilitySystem.ts`

- `createAbilityState()` initialises both new maps
- `equipActiveAbility()` and `grantPassiveAbility()` accept an optional `source` param (default `learned`)
- `memorizeSpell()` records explicit `learned` source
- New exported API:
  - `grantEquipmentActiveAbility(world, holderEid, abilityId, instanceId)` — grants with `equipment` source
  - `grantEquipmentPassiveAbility(world, holderEid, abilityId, instanceId)` — grants with `equipment` source
  - `revokeEquipmentAbilityGrants(world, holderEid, instanceId)` — revokes all grants for a specific equipment instance; ability only removed from lists when all sources are gone; cleans up applied passive stat modifiers when the last source is removed
  - `migrateAbilityStateToSourceTracking(state)` — back-fills `{ kind: 'learned' }` for abilities present in ID lists without source entries (backward-compat A1 migration)

### Carryover — `src/game/playerCarryover.ts`

- `snapshotAbilityState` now **strips all `equipment` sources** before saving; abilities whose only source was equipment are also dropped from the ID lists. This prevents stale `instanceId` references after floor transitions (instance IDs are per-world and not stable across carryovers).
- `restoreAbilityState` calls `migrateAbilityStateToSourceTracking` for old snapshots lacking the new fields.
- `AbilityStateSnapshot` interface updated with optional `activeAbilityGrantSources?` / `passiveAbilityGrantSources?` fields.

### Skill system — `src/game/systems/skillSystem.ts`

- Level-5 milestone passive grant now passes `{ kind: 'skill', skillId: def.id }` source

### Unequip TODO hooks

Three call sites had TODO comments added marking where `revokeEquipmentAbilityGrants` must be called once equipment-ability wiring is implemented:

- `src/engine/EquipmentUI.ts` — `unequipSlot()`
- `src/game/floor2Scenario.ts` — neck slot swap
- `src/game/scenarios/starterWeaponEquip.ts` — starter weapon swap

### Test coverage — `tests/game/ability-grant-sources.test.ts` (31 tests)

- Source recording (learned, skill, equipment)
- Multiple sources per ability; duplicate grant accumulation
- Revoke isolation (one equipment source removed → others intact)
- Equipment-only ability fully removed when last source revoked; stat modifiers cleaned
- Active slot cap enforced with equipment grants
- `migrateAbilityStateToSourceTracking` idempotency
- Carryover: equipment-only abilities dropped; mixed-source ability survives with non-equipment sources; old snapshot migration

## Key design decisions

1. **Canonical ID lists unchanged** — `equippedActiveAbilityIds` / `passiveAbilityIds` remain the authoritative truth; source maps are additive metadata.
2. **Multi-source: ability persists until all sources revoked** — same ability can be granted by both equipment and a skill; revoking the equipment doesn't remove it.
3. **Layer constraint respected** — `equipmentSystem` (core) cannot call game-layer `revokeEquipmentAbilityGrants`. TODO hooks at call sites document the integration point for the next issue.
4. **Carryover equipment-source stripping** — avoids stale instance ID references; equipment abilities re-granted on re-equip in the new world (requires D-tier wiring when equipment-ability integration ships).
5. **Migration conservative** — back-fills everything missing as `learned`; skill-source recovery from saved skill state deferred to when skill-reset feature ships (non-blocking per plan review).

## Remaining work (deferred to next issues)

- **D-tier**: Wire `grantEquipmentActiveAbility` / `grantEquipmentPassiveAbility` into `equip()` outcomes (requires game-layer wrapper or hook on the equip path). Wire `revokeEquipmentAbilityGrants` at the three TODO call sites.
- **Future**: Improve carryover by snapshotting `itemDef→abilityId` manifests so equipment-sourced abilities survive floor transitions without stale instanceIds.

## Verification

- `verify:fast` — ✅ 87 test files, 1260 tests
- `typecheck` — ✅ clean
- Review ledger — ✅ valid 3🍎 (`plan_review` gpt-5.4 + `code_review` claude-opus-4.8)
