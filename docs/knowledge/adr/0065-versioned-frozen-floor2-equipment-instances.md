# ADR 0065: Versioned Frozen Floor 2 Equipment Instances

## Status

Accepted

## Date

2026-07-18

## Estimated Complexity

🍎 x 3 — introduces a new versioned identity layer, cryptographic fingerprinting, feature-flagged registry, and a coexistence contract with the existing per-entity equipment system.

## Context

The existing equipment system (`src/game/equipment/equipmentSystem.ts`) uses per-entity
`EquipmentState` with a numeric monotonic `EquipmentInstanceId` as its instance identity.
This is sufficient for Floor 1 items, which are catalog-derived and fully reconstructible
from their `EquipmentItemDef`.

Floor 2 introduces **generated equipment**: items whose identity, stats, and display
properties are created procedurally at floor-load time and must survive floor transitions
and save/load cycles without re-running the generation pipeline. The Floor 1 identity
model (`number` ID + `EquipmentItemDef` lookup) cannot represent an instance that:

- Is unique to a run and floor;
- Has a content hash for tuning-drift detection;
- Must be carried across floor boundaries with full fidelity;
- May contain effects and stats that no catalog entry encodes.

A separate versioned identity contract is needed for generated equipment. This decision
records how it coexists with the existing Floor 1 system.

## Decision

### DEC-001: Separate type namespace for generated instances

Generated Floor 2 equipment instances use `GeneratedEquipmentInstanceId`
(`gei:v1:<runKey>:<ordinal>`) rather than the numeric `EquipmentInstanceId`.
The run key is derived deterministically from the world seed — never from wall-clock
time. The ordinal is a monotonically increasing non-negative integer per run.

The two namespaces are disjoint by type (branded string vs. number). The Floor 2
generated system is an additive layer that does not modify the Floor 1 schema.

### DEC-002: World-scoped registry with WeakMap storage

A `WeakMap<GameWorld, Map<GeneratedEquipmentInstanceId, GeneratedEquipmentInstanceV1>>`
holds all generated instances. The registry is automatically garbage-collected when the
world is GC'd — no manual teardown required.

All other containers (bag, equipped slots, reward bundles, shop stock, carryover) store
`instanceId` references only; the registry is the sole owner of full records.

### DEC-003: Cryptographic fingerprinting for tuning-drift detection

Each instance carries a `sha256:` fingerprint over its canonical JSON (keys sorted
lexicographically, no undefined, decimal numbers, ownership/container fields excluded).
The fingerprint is recomputed and validated during both registration and hydration.

A fingerprint mismatch at hydration time means a catalog change altered a frozen record
("tuning drift"), which is a hard error: the record is rejected and reported.

### DEC-004: Schema versioning — fail closed for unknown versions

The schema identifier `'floor2-equipment-instance/v1'` is the only known version. Any
record with an unrecognized `schemaVersion` is rejected without processing. This prevents
silently accepting records from a future schema version that this code cannot validate.

### DEC-005: Rarity and enhancement constraints (Floor 2 scope)

Floor 2 generated items are limited to `common`, `uncommon`, and `rare`. Common items have
no affixes (budget 0), uncommon have one minor affix (budget 1), and rare have two units
(either two one-unit affixes or one two-unit affix). Enhancement levels are integers 0–5.

Rarities above Rare (Epic, Legendary, etc.) are not valid Floor 2 generation outcomes and
are rejected by structural validation.

### DEC-006: Feature-flag gating

Registration is gated by `world.floor2EquipmentFlags.floor2EquipmentRegistry`. Lookups,
snapshots, and hydration are always permitted regardless of flag state — disabling the flag
stops new generation but does not destroy persisted state.

### DEC-007: Deep-clone and recursive freeze before storage

Instances are deep-cloned and recursively frozen before being stored. This prevents callers
from mutating registered content after registration, and ensures that mutations to the
original object cannot race with the async fingerprint validation.

### DEC-008: Coexistence with the Floor 1 equipment system

The generated registry is an additive layer. It does not modify `EquipmentState`,
`EquipmentInstance`, or `equipmentSystem.ts`. The Floor 1 system remains the authority for
equip/unequip logic and stat calculation. When a generated Floor 2 item is equipped, the
equip system will reference the generated registry to obtain its resolved stats.

Migration path: future slices may bridge `GeneratedEquipmentInstanceV1` into the equip
system via an adapter; that decision is deferred to the relevant slice.

### DEC-009: Hydration bypasses the generation flag

`hydrateRegistry` does not check `floor2EquipmentRegistry`. Temporarily disabling a slice
to debug or A/B-test must not destroy persisted data. Hydration also accepts `unknown`
input and runs shape guards before structural/fingerprint validation so that a malformed
save record is collected as a recoverable error instead of throwing.

## Consequences

### Positive

- **POS-001**: Generated instance identity is stable across floor transitions and save
  cycles — a registry lookup is always O(1).
- **POS-002**: Fingerprinting detects tuning drift when a catalog change would silently
  alter frozen behavior.
- **POS-003**: WeakMap storage means the registry is zero-cost to tear down and cannot
  leak between test worlds.
- **POS-004**: The Floor 1 equipment system is unmodified; Floor 2 generated equipment is
  purely additive.
- **POS-005**: Hydration accepts `unknown` input and collects per-record errors, so a
  single corrupt save record does not abort the load of all records.

### Negative

- **NEG-001**: Two identity namespaces (numeric Floor 1, branded-string Floor 2) must be
  reconciled when downstream systems equip a generated item — a bridge adapter is needed.
- **NEG-002**: Async fingerprint computation adds latency to registration and hydration
  (one SHA-256 per instance). This is acceptable for floor-load transitions.
- **NEG-003**: The `contentRevision` mechanism is defined but the enhancement-revision
  operation (which increments it) is deferred to a future slice.

### Risks

- **RSK-001**: Fingerprint recomputation on hydration means every catalog change that
  affects a generated item's content will break saved runs. Mitigation: frozen fields are
  computed at generation time and stored; catalog updates do not retroactively alter them.
- **RSK-002**: Deep-clone and recursive freeze add shallow object traversal cost. For the
  sizes expected (≤ dozens of instances per floor), this is negligible.

## Alternatives Considered

### Extend the existing numeric EquipmentInstanceId

Pro: single identity system. Con: numeric IDs provide no provenance, cannot encode
version or schema, and clash with the deterministic-per-run requirement for generated items.

### Content-addressed identity (hash-only, no separate instanceId)

Pro: no ID allocation required. Con: two instances with identical stats and effects would
be indistinguishable; ownership tracking (which bag slot, which floor) would be impossible
without the stable `instanceId`.

### Store full instances inside EquipmentState

Pro: single source of truth for equip logic. Con: `EquipmentState` is per-entity and not
designed for world-scoped durability; its `Map<number, EquipmentInstance>` cannot be
keyed by a branded string without schema changes to the Floor 1 system.
