# ADR 0067: Quartermaster stock ownership and atomic purchasing

## Status

Accepted

## Date

2026-07-21

## Estimated Complexity

🍎 x 4 — crosses shared contracts, core transaction ownership, game lifecycle generation,
and real Floor 2 runtime wiring.

## Context

Floor 2 guarantees a Quartermaster NPC and already has a world-owned generated-equipment
instance registry, but it previously lacked authoritative generated stock or a purchase
transaction. UI and AI consumers need the same affordability and utility data, while the
purchase path must prevent stale offers, duplicate ownership, partial writes, and identity
substitution.

- **CTX-001**: Generated equipment has immutable registry identity. Shop and inventory
  state must carry references rather than clone or regenerate instance records.
- **CTX-002**: Stock must be deterministic for a floor seed and restock epoch without
  shifting `world.rng`, because the settlement and combat pipelines share that stream.
- **CTX-003**: Every fallible validation must complete before gold, stock, inventory, or
  settlement state changes.
- **CTX-004**: Existing inventory bags are unbounded by default, but transaction code must
  support an explicit generated-equipment capacity contract when one is configured.
- **CTX-005**: Maintainers, gameplay systems, UI, and AI consumers are stakeholders in the
  stock, projection, and transaction contracts.

## Decision

The Quartermaster owns first-class epoch stock in the Floor 2 settlement snapshot. Each
offer references one exact generated-equipment registry instance and has quantity one.
Game-layer generation uses a seed derived from floor seed plus restock epoch, while the
core layer owns the shared offer projection and atomic purchase transaction.

- **DEC-001**: Generate 3-4 wearable common/uncommon instances at the player's current
  level from the canonical landed equipment catalog. Rare items, generated weapons, and
  non-stat effects remain excluded until their equip/runtime contracts support them.
- **DEC-002**: Inject a dedicated `SeededRandom` into the existing generator so stock
  generation does not consume or reorder the world RNG stream.
- **DEC-003**: Identify stock by floor seed and epoch, and identify offers by stock plus
  ordinal. Current-epoch restock is idempotent; only an exact next epoch may advance.
- **DEC-004**: Retire unsold prior-epoch instance IDs. The retired set defends against
  corrupted current stock reintroducing an old registry-backed instance under a fresh
  stock identity.
- **DEC-005**: Perform stock identity, quantity, availability, inventory, funds, capacity,
  registry, retirement, and physical ownership checks before constructing and committing
  replacement bag, stock, settlement, and gold values.
- **DEC-006**: Expose one read model from the same purchase preflight used by the
  transaction so UI and AI cannot diverge on affordability or eligibility.

## Consequences

### Positive

- **POS-001**: A successful purchase transfers the exact displayed generated instance and
  cannot partially debit gold or mutate stock.
- **POS-002**: Stale, duplicate, missing, unaffordable, full-capacity, and ownership-
  conflicted purchases return explicit failure codes without writes.
- **POS-003**: Equal floor seeds, player levels, and epochs produce equal stock while
  preserving all unrelated gameplay RNG draws.
- **POS-004**: UI and AI receive one authoritative eligibility and utility projection.

### Negative

- **NEG-001**: Floor 2 settlement snapshots now carry a required stock contract in addition
  to the legacy static Quartermaster inventory shape.
- **NEG-002**: Retired instance references and immutable registry records remain resident
  for the floor lifetime, adding a small amount of state per restock.
- **NEG-003**: Generated stock is intentionally restricted to wearable stat-effect gear
  until generated weapons and grant effects have complete runtime support.

### Risks

- **RSK-001**: Economy tuning uses a new deterministic level/rarity price curve and may
  require later balance adjustment without changing the identity or transaction contract.
- **RSK-002**: A future persistence boundary must serialize settlement stock and the
  generated registry together to preserve referenced identities.
- **RSK-003**: If restock frequency becomes unbounded, retired-reference retention should be
  replaced by a bounded ownership ledger or floor-lifecycle compaction.

## Alternatives Considered

### Generate equipment on purchase

- **ALT-001**: **Description**: Display a template offer and generate its concrete instance
  only when the player buys it.
- **ALT-002**: **Rejection Reason**: The displayed item would not be authoritative, exact
  identity would not exist before purchase, and click timing would influence generation.

### Dedicated Quartermaster ECS system

- **ALT-003**: **Description**: Add a per-frame ECS system to own stock, pricing, restock,
  and purchase behavior.
- **ALT-004**: **Rejection Reason**: Stock changes only at floor lifecycle or transaction
  boundaries; a runtime system would add ordering and wiring complexity without benefit.

### Optimistic mutation with rollback

- **ALT-005**: **Description**: Debit funds and mutate stock/inventory incrementally, then
  restore snapshots if a later check fails.
- **ALT-006**: **Rejection Reason**: Preflight followed by immutable next-state construction
  is simpler, avoids rollback gaps, and provides a stronger no-partial-write guarantee.
