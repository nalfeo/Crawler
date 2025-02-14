# ADR 0065: Versioned Frozen Floor 2 Equipment Instances

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

3 apples - this decision locks contracts across inventory, weapons, rewards,
economy, floor carryover, achievements, and deterministic AI without adding
runtime implementation.

## Context

Floor 2 equipment must represent generated copies rather than only static item
definitions. The same copy can begin in merchant stock or an achievement reward,
move into the bag, occupy one or more equipped slots, and survive a floor
transition. Its rolled stats, name, art, weapon behavior, abilities, and passives
must not reroll when a different consumer reads it.

The shipped equipment system currently stores a numeric world-local instance ID
beside a static `EquipmentItemDef`. The weapon system reads immutable static
`WeaponDef` records. Achievement rewards are reveal-only, merchant purchases use
separate mutation paths, and floor carryover serializes legacy inventory and
equipment surfaces. Extending each consumer independently would create parallel
item shapes and make identity, rollback, and migration impossible to reason about.

The epic also needs rapid progression without flattening every build into a
smooth curve. The representative-build median aggregate realized-DPS gate is
1.7x-2.3x for each five-level band, initially 1 -> 6 and 6 -> 11.

## Decision

- **DEC-001**: Floor 2 uses one versioned generated-equipment registry.
  Containers and offers store stable instance IDs; the registry stores the
  immutable resolved records. Bag entries, equipped slots, reward bundles, boss
  chests, Quartermaster and other shop stock, and carryover may not define
  parallel instance shapes.
- **DEC-002**: A generated instance resolves exactly once in this order: base
  template -> item level -> inherent scaling -> rarity scalar and effect-unit
  budget -> enhancement +N -> affixes/effects -> frozen stats, name, art, weapon
  snapshot, and fingerprint. The only later content transform is a legal atomic
  enhancement revision; it never rerolls prior choices.
- **DEC-003**: Static `WeaponDef` records remain immutable templates.
  Weapon-bearing equipment freezes an `ActiveWeaponSnapshotV1` after all instance
  resolution. Runtime firing selects the snapshot by equipped instance ID rather
  than mutating or cloning a global `WeaponDef`.
- **DEC-004**: Fingerprints are versioned SHA-256 digests of canonical immutable
  instance content. Ownership container, merchant price, and claim state are
  excluded so moving one instance does not change its fingerprint.
- **DEC-005**: Rarity is limited to Common, Uncommon, and Rare for this epic.
  Their inherent scalars are 1.00, 1.05, and 1.10. Common has zero effect units,
  Uncommon exactly one minor unit, and Rare exactly two units. Enhancement is
  bounded at +0..+5 and adds 5% post-rarity inherent damage or armor per step.
- **DEC-006**: Equipment-granted abilities and passives are source-owned. Every
  grant records `equipment:<instanceId>:<effectOrdinal>` and remains active while
  at least one source exists. Unequip removes only the originating sources. The
  existing active-ability slot limit remains authoritative.
- **DEC-007**: Achievement reward instances resolve atomically at unlock time and
  remain immutable inside the reward bundle. Claim transfers the whole bundle and
  marks it claimed in one transaction, or performs no mutation.
- **DEC-008**: Player and AI purchases share one atomic public purchase API.
  Deterministic AI scores frozen instances by expected run value and may pursue
  an optional settlement-maintenance goal only through the existing objective
  route planner and public inventory/equip/purchase APIs.
- **DEC-009**: Seven independently staged Floor 2 equipment flags remain default
  off and enforce dependency closure. No flag exposes equipment on Floor 1.
  Unknown future instance schemas fail closed; supported migration is
  deterministic, idempotent, and never rerolls frozen content.
- **DEC-010**: Unique equipment is deferred outside the current 37-node epic DAG.
  Its authored identities, bespoke mechanics, acquisition, duplicates, lore, and
  dedicated art are tracked in
  <https://github.com/nalfeo/Crawler/issues/1274>.

## Authority

| Contract                                                                          | Normative authority                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Five-level DPS growth principle                                                   | `.specify/memory/constitution.md`                        |
| Generated identity, resolution, ownership, rewards, economy, AI, flags, migration | `.specify/specs/equipment-system.md`                     |
| Static weapon template and frozen active snapshot                                 | `.specify/specs/weapon-system.md`                        |
| Epic counts, stable manifest, DAG, release flags, and rollout                     | `docs/knowledge/epics/floor-2-equipment/PLAN.md`         |
| Cached observed lifecycle facts                                                   | `docs/knowledge/epics/floor-2-equipment/epic-state.json` |

## Consequences

### Positive

- One identity and ownership model spans every Floor 2 equipment consumer.
- Reward viewing, UI rendering, save/load, and catalog edits cannot reroll an
  existing item.
- Static weapon balance tables stay immutable while generated weapons can carry
  per-instance resolved behavior.
- Source ownership prevents unequipping one item from deleting an ability or
  passive still granted elsewhere.
- Atomic purchase, claim, and enhancement transactions provide deterministic
  rollback boundaries for player and AI callers.
- Feature flags allow registry, catalog, rewards, economy, UX, world integration,
  and AI maintenance to ship independently without exposing partial Floor 1
  behavior.

### Negative

- Carryover and save data must serialize the registry plus references instead of
  only static item IDs and counts.
- Every generated record duplicates the runtime fields needed for its frozen
  behavior.
- Explicit canonicalization, migration, and ownership validation add work before
  gameplay-facing equipment can ship.
- Enhancement requires an atomic content revision and fingerprint update rather
  than mutating one stat in place.

### Risks

- A consumer that caches a static definition instead of resolving an instance ID
  could display or execute stale behavior. Integration tests must move the same
  ID through every container.
- A future runtime field omitted from the weapon snapshot or fingerprint could
  make two behaviorally different items appear identical. Snapshot versioning and
  exhaustive field tests mitigate this.
- Overly generous rarity, enhancement, or effect budgets could violate the
  constitutional DPS bands. The deterministic representative-build fixtures are
  the release authority, not hand-picked examples.
- Partial feature-flag activation could orphan persisted items. Dependency
  closure and preserve-on-disable semantics mitigate this.

## Alternatives Considered

### Consumer-Owned Item Shapes

- **Description**: Let inventory, merchants, rewards, chests, and carryover each
  store the fields they need.
- **Rejected**: Copies would drift, ownership would be ambiguous, and moving an
  item could silently reroll or discard fields.

### Mutable Per-Instance WeaponDef

- **Description**: Clone a static `WeaponDef` and mutate its fields for every
  generated weapon.
- **Rejected**: It blurs immutable catalog data with runtime identity, encourages
  aliasing, and makes fingerprints and migrations depend on object history.

### Lazy Resolution When Displayed or Equipped

- **Description**: Store a generation seed and derive the item whenever UI or
  gameplay needs it.
- **Rejected**: Catalog changes, draw-order changes, and consumer-specific code
  could change an already-earned reward. Unlock-time immutability would not hold.

### Source-Less Ability and Passive Sets

- **Description**: Add a granted ability to a set on equip and delete it on
  unequip.
- **Rejected**: Two items or a non-equipment source can grant the same effect;
  deleting the set entry would remove grants that still exist.

### Include Unique Equipment in the Generated Rarity Ladder

- **Description**: Add a fourth rarity with bespoke rolls during this epic.
- **Rejected**: Authored identity, acquisition, duplicate, lore, and art rules are
  not ordinary effect-budget concerns and would expand the approved epic beyond
  its three-rarity release gate.
