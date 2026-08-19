# ADR 0083: Equipment Slot Retirement Migration

## Status

Accepted

## Date

2026-08-18

## Estimated Complexity

🍎 x 4 — Changes the shared equipment contract, persistence restore, and sprite authoring boundaries.

## Context

The active equipment contract was reduced to ten slots: head, neck, mainHand,
chest, offHand, gloves, legs, ring1, feet, and ring2. Older carryover snapshots
and theme-equipment plans can still name retired slot IDs or the retired static
equipment that used them. Treating those references as active would revive
removed concepts; rejecting every old carryover snapshot would unnecessarily
brick restore.

## Decision

Migrate carryover deterministically at the restore boundary. Retired static
equipment inventory/equip records are dropped. Generated instances whose frozen
slot list contains a retired ID are retired from the registry and all direct
player ownership references before validation; retained registry instances may
therefore have sparse historical ordinals. No retired item is mapped to an
unrelated active slot.

Theme roster prompts list only the canonical active non-hand slots, and the
plan schema rejects retired or unknown slots during persisted-plan loading,
proposal validation, and state construction.

## Consequences

### Positive

- **POS-001**: Old snapshots restore without reviving belts, cloaks, or other retired equipment.
- **POS-002**: Runtime and persisted theme plans accept only the ten-slot contract.
- **POS-003**: Generated registry identity remains stable for surviving instances.

### Negative

- **NEG-001**: Players lose retired equipment during migration rather than receiving a replacement.
- **NEG-002**: Registry snapshots can contain deliberate ordinal gaps after retirement.

### Risks

- **RSK-001**: Future registry consumers must treat instance IDs as stable keys, not infer a contiguous count from them.

## Alternatives Considered

### Remap retired equipment into surviving slots

- **ALT-001**: Assign each retired item to a legal active slot during restore.
- **ALT-002**: **Rejection Reason**: This preserves semantically invalid concepts such as belts and bracers, and changes their gameplay category.

### Reject every legacy snapshot or plan

- **ALT-003**: Fail validation when any retired item or slot appears.
- **ALT-004**: **Rejection Reason**: A removed item should not make an otherwise valid run impossible to restore.

### Reindex surviving generated instances

- **ALT-005**: Renumber generated instances after removing retired records.
- **ALT-006**: **Rejection Reason**: Instance IDs are referenced by inventory, abilities, bundles, and rewards; preserving survivor identity is less error-prone.
