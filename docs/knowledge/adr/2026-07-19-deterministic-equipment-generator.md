# ADR: Deterministic equipment generator (D1)

## Status

Accepted

## Date

2026-07-19

## Estimated Complexity

🍎🍎🍎 — introduces a new generator in `src/game/`, extends `src/core/` registry with deferred-snapshot helpers, and adds new shared types in `src/shared/`.

## Context

Floor 2 gameplay requires generating equipment instances from templates at runtime. Each instance
must be fully deterministic (same seed + request = same instance), must not mutate static
definitions, and must produce frozen payloads covering stats, names, art keys, and active weapon
snapshots for weapon equipment.

The existing B1 registry (`src/core/generated-equipment-registry.ts`) stores and validates
immutable `GeneratedEquipmentInstanceV1` records, but did not provide a generator for producing
them. Callers would need to either construct raw registry inputs directly (coupling business logic
to the registry schema) or duplicate the rarity/budget/enhancement logic across slices.

## Decision

1. **`generated-equipment-generator.ts` owns the generation pipeline** in `src/game/`. It
   encapsulates: template resolution → item-level scaling → rarity scalar → enhancement multiplier
   → effect budget selection → stat accumulation → frozen payload assembly. This keeps the
   generator as a pure function over `SeededRandom` + a `GeneratedEquipmentRequest`, matching
   the ECS layer rules (no Phaser imports, fully portable).

2. **Deferred snapshot stub pattern** for weapon equipment. The generator calls
   `createActiveWeaponSnapshotInput(weaponDefId, overrides?)` which returns a lightweight stub
   `{ weaponDefId, overrides? }`. The registry's `validateFrozenFields` expands the stub into a
   full `ActiveWeaponSnapshotV1` only on the create-input path (`allowDeferredSnapshot=true`).
   The restore/validate path rejects deferred stubs fail-closed, preventing serialized stubs from
   surviving past the initial `registerGeneratedEquipment` call.

3. **`equipment-ability-grants.ts` wraps main's ability-grant API** in `src/game/`. It exposes
   `grantEquipmentAbilitySources`/`revokeEquipmentAbilitySources` that delegate to
   `grantEquipmentActiveAbility`/`grantEquipmentPassiveAbility`/`revokeEquipmentAbilityGrants`
   from the world-owned abilitySystem, keeping the generator contract source-tracked and
   consistent with the existing ability state shape.

4. **Rarity/budget enforcement** is canonical: Common = 0 effect units, Uncommon = exactly 1
   minor unit, Rare = exactly 2 units (single 2-cost or compatible 1+1 pair). Enhancement `+N`
   is bounded `0..+5`. Inherent rarity scalars are Common 1.00, Uncommon 1.05, Rare 1.10.

## Consequences

### Positive

- Generator is a pure, deterministic function; identical inputs always produce identical instances.
- Static definitions are never mutated.
- Rarity/budget/enhancement invariants are tested at unit, property, and integration levels.
- Deferred snapshot guard ensures no stub leaks into persisted instance records.

### Negative

- Two registry entry points (`validateFrozenFields` with `allowDeferredSnapshot` flag) require
  callers to use the correct path; misuse at the creation path is detectable but requires knowing
  the flag.
- The effect catalog is a module-level frozen constant and not fingerprinted in the generation
  metadata (deferred to a later slice).

### Risks

- Callers bypassing `createGeneratedEquipmentInstance` and directly calling `validateCreateInput`
  with a hand-crafted stub could be misled if the stub is malformed — the registry's
  fail-closed `validateActiveWeaponSnapshotV1` check prevents silent bad state but produces a
  runtime error rather than a validation result.

## Alternatives Considered

1. **Inline generation in the registry** — rejected because it would mix the generation business
   logic with the storage/validation concern, making the registry harder to test in isolation.
2. **Eager snapshot resolution (no deferred stub)** — rejected because the generator needs to
   produce a `GeneratedEquipmentCreateInputV1` from pure data (no world access), and building a
   full `ActiveWeaponSnapshotV1` requires the world's weapon definition lookup. The deferred stub
   lets the generator stay world-free and allows the registry to perform the expansion in the
   world context.
3. **A separate weapon-instance generator** — rejected because unifying the creation pipeline
   under a single `createGeneratedEquipmentInstance` function reduces the surface area and keeps
   all budget/rarity enforcement in one place.
