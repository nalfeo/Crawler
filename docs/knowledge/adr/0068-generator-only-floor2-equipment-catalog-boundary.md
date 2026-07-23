# ADR 0068: Generator-Only Floor 2 Equipment Catalog Boundary

## Status

Accepted

## Date

2026-07-22

## Estimated Complexity

🍎 — documents an already-landed architecture decision; no new code

## Context

Two separate equipment-base catalogs now coexist in the codebase:

1. **Static inventory catalog** (`src/shared/equipmentDefs.ts` — `getEquipmentDefForItem`):
   The canonical set of items that exist in the static game inventory (Floor 1 loot, shop
   stock, starter weapons, Quartermaster GEAR stock). Every ID in this catalog is reachable
   from `listEquipmentItems`, `getEquipmentDefForItem`, and the Floor 1/2 UI surfaces.

2. **Generator-only Floor 2 Wave A catalog** (`src/shared/data/floor2-weapon-bases.ts` —
   `FLOOR2_WEAPON_WAVE_A_BASES` / `getFloor2WeaponWaveABase`):
   The 25 immutable Floor 2 weapon bases that are only accessible through the generated-
   equipment pipeline (`generated-equipment-generator.ts` → `resolveGeneratedEquipmentBase`).
   These IDs intentionally do not appear in the static inventory enumeration.

The generator's `resolveGeneratedEquipmentBase` function bridges both catalogs:

```
resolveGeneratedEquipmentBase(baseId)
  → getFloor2WeaponWaveABase(baseId) ?? getEquipmentDefForItem(baseId)
```

The review feedback on PR #1749 required this two-catalog decision to be documented in an ADR
because it affects `src/shared/`, `src/game/`, and the static inventory surface — spanning 2+
systems.

## Decision

### 1. The catalogs stay separate by design

Floor 2 Wave A weapon bases are **generator-only**: they are produced on demand by the
`generateEquipmentInstance` pipeline and are never enumerated in the static inventory. Merging
them into `equipmentDefs.ts` would:

- Expose 25 new IDs to every caller of `listEquipmentItems`, breaking inventory isolation for
  Floor 1 and unvalidated Floor 2 surfaces.
- Require `equipmentDefs.ts` to depend on Floor 2-specific modules, adding cross-floor coupling
  to a file that is currently Floor-agnostic.
- Complicate the Quartermaster GEAR stock logic, which filters `equipmentDefs.ts` by `rarity`
  to form `FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS` (see `equipmentDefs.ts:355-360`).

### 2. ID invariants and synchronization

The two catalogs use non-overlapping ID namespaces enforced by prefix and type contracts:

- Floor 2 Wave A bases carry `Floor2WeaponStableId` branded IDs with the `weapon.` prefix
  (e.g. `weapon.iron-cleaver`). These IDs are rejected by `getEquipmentDefForItem`, which
  only returns items registered in `EQUIPMENT_DEFS` (legacy slugs without the `weapon.` prefix).
- `validateWaveABases()` runs at module load in `floor2-weapon-bases.ts` to enforce family
  counts (each of the ten canonical weapon families must have exactly the declared number of
  bases, currently 2–3). This is a deterministic invariant that fails the test suite on
  violation.
- Unit tests in `tests/unit/floor2-weapon-wave-a.test.ts` assert exact 25-ID roster and
  ten-family distribution; these tests fail if IDs are accidentally added to or removed from
  the generator catalog.

### 3. Ownership rules

- **`equipmentDefs.ts`** owns all static-inventory IDs. No Floor 2 generator-only ID may be
  added to this file without an explicit inventory-integration ADR and corresponding inventory
  gate changes.
- **`floor2-weapon-bases.ts`** owns the Wave A generator catalog. New Wave A weapon bases must
  pass `validateWaveABases` family-count invariants and have matching `Floor2WeaponStableId`
  entries in `floor2-equipment-art.ts`.
- **`generated-equipment-generator.ts`** is the only bridge. The `resolveGeneratedEquipmentBase`
  function is the single point of truth for which catalog a given `baseId` comes from; all
  generation callers go through this function and never query either catalog directly.

### 4. Art key contract

Floor 2 Wave A bases derive their runtime art key from the stable ID:

```
artKey = `equipment/${stableId.replace('.', '/')}` as Floor2EquipmentRuntimeKey
```

This key is typed by `Floor2EquipmentRuntimeKey` and validated against
`FLOOR2_EQUIPMENT_ART_DEFINITIONS` (defined in `floor2-equipment-art.ts`) at compile time.
The existing generic art fallback in the renderer handles the case where no sprite has been
generated yet for a given key.

### 5. Shared WeaponDef defaults

Both catalogs share one default factory (`src/shared/weapon-def-defaults.ts` →
`createWeaponDef`) to prevent silent balance-default drift. Callers in `weaponDefs.ts` (the
canonical `WEAPON_DEFS` legacy catalog) and in `floor2-weapon-bases.ts` both alias
`createWeaponDef` as their local `weaponDef` helper. Any change to a balance default
propagates to both catalogs simultaneously.

## Consequences

### Positive

- Static inventory isolation is preserved: `listEquipmentItems` and all Floor 1/2 UI surfaces
  see only explicitly registered items.
- Floor 2 weapon bases are type-safe and validated at module load; there is no silent
  divergence path.
- The generator's bridge function is the single ownership boundary, making auditing trivial.
- Balance defaults cannot silently diverge between the two catalogs.

### Negative

- `resolveGeneratedEquipmentBase` must be updated whenever a new generator-only catalog is
  introduced (e.g. Floor 2 Wave B, Floor 3 bases). This is a single-function change but
  requires knowing the convention.
- There is no single exhaustive list of "all generator-only IDs" at the shared-module level;
  callers must union the catalogs manually if they need to enumerate across both.

### Risks

- A future contributor could add a `weapon.` ID to `equipmentDefs.ts` without realizing it
  collides with the generator-only namespace. The ID prefix contract is currently enforced only
  by naming convention and the `Floor2WeaponStableId` brand type, not by a runtime guard in
  `getEquipmentDefForItem`. If the catalogs grow, a deterministic duplicate-check at module
  load (union of both catalogs vs. a set) would strengthen this.

## Alternatives Considered

1. **Merge all IDs into `equipmentDefs.ts`** — rejected because it exposes generator-only
   bases to static inventory enumeration and adds cross-floor coupling (see Decision §1).

2. **Maintain a third "generated base registry" separate from both catalogs** — rejected
   because it adds a third lookup table that must be kept in sync with `floor2-weapon-bases.ts`
   with no clear ownership benefit over the current bridge function.

3. **Reverse lookup: `floor2-weapon-bases.ts` delegates to `equipmentDefs.ts` for the
   `EquipmentItemDef`** — rejected because the Floor 2 weapon bases have authored
   `weightLb`, `tags`, and `weaponId` mappings that differ from Floor 1 equipment and should
   not co-locate with the Floor 1 GEAR stock in `equipmentDefs.ts`.
