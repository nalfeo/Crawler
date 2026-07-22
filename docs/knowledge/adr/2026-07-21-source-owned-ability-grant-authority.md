# ADR: Source-Owned Ability Grant Authority

## Status

Accepted

## Date

2026-07-21

## Estimated Complexity

🍎🍎🍎 — versioned ownership spans shared contracts, generated-equipment identity,
gameplay state, carryover, and the engine loadout surface.

## Context

Active and passive abilities can be granted independently by learning, skill
milestones, or generated equipment. Plain ability-ID lists cannot identify which
grant should disappear when one equipment instance is removed. They also cannot
preserve an ability that still has another source, distinguish ownership from
active-slot configuration, or migrate old carryover snapshots without duplicating
passive stat modifiers.

Generated-equipment grants add a second authority boundary: a source must identify
one canonical registry instance and one resolved effect ordinal. Divergent instance
ID validators would allow a grant to be created but make the same source impossible
to revoke.

## Decision

1. `AbilityGrantOwnership` is the versioned authority for active and passive
   availability. Each ability maps to a set of typed source IDs for learned, skill,
   equipment, or legacy provenance.
2. `equippedActiveAbilityIds` remains configuration, not ownership.
   `ownedActiveAbilityIds`, learned IDs, and passive IDs are deterministic derived
   views of catalog-backed ownership. Retired IDs may remain inert in ownership for
   save compatibility but cannot occupy runtime slots or apply effects.
3. Grant and revoke operations validate complete batches on cloned state and install
   them atomically. An ability is removed only when its final source disappears.
4. Equipment sources use
   `equipment:<GeneratedEquipmentInstanceId>:<effectOrdinal>`. The shared generated
   instance parser is canonical for shared, core, and legacy creator paths, including
   lowercase dotted run keys and safe non-negative integer ordinals.
5. Equipment grants resolve the authoritative frozen registry instance and its
   `resolvedEffects`. Revocation scans ownership by the exact validated instance
   prefix so registry teardown cannot strand a source.
6. Carryover serializes ownership but omits derived passive modifiers. Modern
   restores reconstruct passive modifiers once; old snapshots that persisted both
   applied-passive IDs and modifiers retain that tracking to avoid duplication.
7. The engine loadout surface includes owned-but-unconfigured actives so a grant
   received at the ten-slot cap remains selectable later.

## Consequences

### Positive

- Removing one item cannot revoke an ability still owned through another item,
  learning, or a skill.
- Generated-instance grant and revoke paths share one fail-closed identity contract.
- Retired catalog entries remain migration-safe without becoming executable.
- Passive modifiers and active slot configuration remain deterministic across
  repeated grant, revoke, and carryover operations.

### Negative

- Ability state now carries versioned nested maps and sets that require explicit
  snapshot conversion and migration.
- Runtime consumers must normalize legacy state before using derived ownership
  views.
- Equipment effects must retain stable effect ordinals because ordinals participate
  in source identity.

### Risks

- A future write path that mutates derived ID lists without ownership can create
  transient disagreement until normalization.
- A new generated-instance creator that bypasses the shared parser could recreate
  grant/revoke asymmetry.
- Future carryover schema changes must continue distinguishing persisted authority
  from reconstructable passive effects.

## Alternatives Considered

- **Keep plain ID lists and revoke by ability ID:** rejected because removing one
  source would also remove independent grants.
- **Store one source per ability:** rejected because learned, skill, and multiple
  equipment sources can coexist.
- **Have core equipment code mutate game ability state directly:** rejected because
  it violates the core-to-game layer boundary.
- **Require the generated registry during revocation:** rejected because teardown or
  carryover ordering could strand valid persisted ownership.
- **Persist passive modifiers as the authority:** rejected because modifiers are
  derived runtime state and are prone to duplication during restore.
