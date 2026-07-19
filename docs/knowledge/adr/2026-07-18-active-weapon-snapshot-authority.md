# ADR: Registry-authoritative active weapon snapshots

## Status

Accepted

## Date

2026-07-18

## Estimated Complexity

🍎🍎 — touches `src/core/`, `src/game/`, and shared equipment contracts without introducing a new ECS system.

## Context

Floor 2 generated equipment can roll per-instance weapon stats after the static
`WeaponDef` template is selected. The combat runtime still expects one
active-weapon shape, while generated equipment must preserve immutable earned
behavior across inventory movement, save/load, and later catalog edits.

Without an explicit authority seam, callers could hand the runtime a mutable or
stale cloned weapon definition. That would let two instances sharing the same
base weapon ID alias each other, silently inherit stale cooldown/readiness
state, or drift away from the registry-owned frozen instance record.

## Decision

1. Generated weapon instances freeze a full `ActiveWeaponSnapshotV1` that is
   runtime-compatible with `WeaponDef` while also carrying:
   - `generatedEquipmentInstanceId`
   - immutable provenance via `sourceWeaponDefId`
   - canonical skill tags
   - a deterministic snapshot fingerprint
2. Static `WeaponDef` records remain immutable templates only. Runtime combat may
   not mutate them and may not treat a caller-owned clone as authoritative.
3. `setActiveWeaponDef(...)` resolves generated snapshots back through the
   world-owned generated-equipment registry and stores the registry-owned frozen
   snapshot as the authoritative active weapon.
4. Active-weapon switch semantics for generated equipment key off snapshot
   identity (`generatedEquipmentInstanceId` + fingerprint) rather than only the
   base weapon ID, so same-template instance swaps still behave like real
   switches.

## Consequences

### Positive

- Generated equipment executes the exact frozen per-instance weapon behavior it
  earned.
- Global `WeaponDef` tables stay immutable and reusable.
- Same-base generated weapon swaps cannot inherit stale readiness/cooldown state
  from a previous instance.
- Save/load, carryover, and UI consumers can trust the registry snapshot as the
  single executable source of truth.

### Negative

- Snapshot validation is stricter and adds more fail-closed checks at the active
  weapon seam.
- The shared generated-equipment types must carry compatibility fields for both
  the older registry path and the new snapshot contract during the transition.

### Risks

- Any future combat field omitted from the frozen snapshot could reintroduce
  drift between registry content and runtime execution.
- Consumers that bypass the registry and cache caller-owned copies would violate
  this contract and recreate aliasing bugs.

## Alternatives Considered

1. **Mutable per-instance `WeaponDef` clones** — rejected because caller-owned
   clones blur template vs instance authority and make fingerprint integrity
   depend on mutation history.
2. **Base-weapon-ID-only switching** — rejected because two generated instances
   of the same template can legitimately differ in rolled combat fields.
3. **Recompute generated weapon behavior from the latest template on equip** —
   rejected because later catalog edits could silently change already-earned
   items.
