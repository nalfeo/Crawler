# ADR 2026-07-19: B3 — Versioned Generated-Equipment Carryover Persistence

## Status

Accepted

## Date

2026-07-19

## Estimated Complexity

🍎🍎🍎 — crosses generated-equipment registry (core), inventory/equipment ownership
(core), sourced abilities (game), frozen weapon runtime state (core/engine), and the real
floor-transition pipeline.

## Context

Floor 2 generates equipment instances at floor-load time and assigns them unique,
stable `instanceKey` identities (ADR 0065, B1). Those instances must survive Floor 1
→ Floor 2 transitions and JSON save/load cycles without rerolling, duplicating, or
losing any part of their frozen payloads, equipped state, sourced ability grants, or
unopened achievement reward bundles.

The existing unversioned player carryover snapshot (`src/game/playerCarryover.ts`)
persisted only static-item bag contents and equipped item IDs. It had no concept of
generated-instance keys, registry snapshots, sourced grants, frozen weapon state, or
reward bundles.

Three design dimensions required a cross-layer decision:

1. **Serialization shape** — whether to persist full generated payloads or only
   registry keys and re-hydrate on restore.
2. **Source authority for equipped state** — whether to replay equip through the
   B2 bag/equip APIs or to bypass them and write directly to the equipment slot map.
3. **Restore-time validation scope** — whether to validate eagerly (before any
   destination mutation) or lazily (per entity, with partial rollback).

## Decision

### Versioned envelope (`player-carryover/v1`)

Introduce an explicit `schemaVersion` discriminant on `PlayerCarryoverSnapshot`.
Unversioned static-only snapshots migrate forward deterministically (empty generated
fields) so legacy saves are preserved. Future versions must bump the discriminant; any
unknown version throws `PlayerCarryoverSnapshotError` before touching the destination
world.

### Registry snapshot as serialization unit

Persist the B1 registry as an opaque `GeneratedEquipmentRegistrySnapshotV1` blob
(produced by `snapshotGeneratedEquipmentRegistry`). Restore it through the existing
`restoreGeneratedEquipmentRegistry` public API so fingerprint and version checks are
enforced centrally. All other containers (bag, equipped slots, reward bundles) store
only `GeneratedEquipmentInstanceKey` references.

### Replay through B2 public APIs

Equip restoration uses `addGeneratedEquipmentToBag` followed by `equipFromBag`
(B2 APIs) rather than writing slot state directly. This ensures the full slot-lock,
stat, and frozen-weapon projection logic executes on restore, matching the original
equip path, and keeps implementation details of the equipment system contained in
`src/core/systems/equipmentSystem.ts`.

### Eager pre-mutation validation

All structural checks — unsupported version, duplicate physical owners, duplicate
slots, dangling registry keys, missing grant sources, and grant/source mismatches —
run against a temporary validation world before any destination-world state is
mutated. This fails closed: if any check fails, the destination world is untouched
and a `PlayerCarryoverSnapshotError` is thrown.

### Sourced grants tracked by equipment key

Active/passive grants added by generated equipment are tagged with a stable
`equipment:<instanceId>:<effectOrdinal>` source ID. Unequip/displacement removes only
grants owned by the specific equipment source; grants retained by a subsequent
independent owner are never revoked by the removed source.

### Run-key propagation

The immutable generated-equipment run key is threaded from
`createFloorMainSceneOptions` through the `FloorMainSceneOptions.generatedEquipmentRunKey`
field so Floor 2 world creation uses the same run key as Floor 1, preventing
identity reroll on the Floor 2 restart.

### Unopened reward bundles as registry-key references

`GeneratedEquipmentRewardBundleV1` stores only the `instanceKey` reference and
the bundle ID. It adds no reward-claim or generation behavior (reserved for B4+).
Restore validates bundle ID uniqueness, confirms each referenced key exists in the
restored registry, and checks no key is owned by multiple bundles before committing.

## Consequences

### Positive

- Exact `instanceKey` identity, frozen payload, sourced grants, and active-weapon
  snapshots survive round-trips without reconstruction from mutable catalogs.
- Deterministic test coverage: unit, ECS, property, and integration tests prove
  exact identity/payload fidelity and explicit fail-closed behavior.
- Pre-mutation validation prevents partial corruption; the destination world is
  either fully restored or untouched.
- Legacy static saves continue to work via forward migration.
- B4+ slices (generation, merchant, reward claim) can build on well-defined V1
  ownership contracts without retrofitting.

### Negative

- The registry snapshot added to `PlayerCarryoverSnapshot` grows the save payload
  linearly with registered instances (bounded by the generated-instance count per
  run).
- Eager validation requires constructing a temporary validation world on every
  restore path, adding a small allocation cost.

### Risks

- Floor transition code paths that bypass `capturePlayerCarryover` /
  `restorePlayerCarryover` will not carry generated instances; any future
  alternate transition path must be wired to the same capture/restore pair.

## Alternatives Considered

1. **Store full generated payloads inline in the snapshot** — rejected because it
   duplicates the registry's authoritative records, bypasses fingerprint validation,
   and couples the snapshot schema tightly to the instance schema.

2. **Lazy per-entity validation with partial rollback** — rejected because partial
   restore leaves the destination world in an undefined mixed state, making recovery
   logic complex and error-prone.

3. **Write directly to equipment slot map on restore** — rejected because it
   bypasses the B2 equip APIs that own stat-projection, slot-locking, and
   frozen-weapon projection. Bypassing them would duplicate logic and could silently
   diverge on future equipment rule changes.
