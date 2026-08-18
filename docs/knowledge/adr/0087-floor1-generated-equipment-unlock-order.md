# ADR 0087: Floor 1 Generated-Equipment Unlock Order

## Status

Accepted

## Date

2026-08-18

## Estimated Complexity

🍎 x 4 — coordinates core equipment transfer, Floor 1 quest progression, and deterministic AI maintenance.

## Context

The Floor 1 shopkeeper quest grants and equips the charm before the broader equipment
inventory becomes available. The AI's boss-chest maintenance previously treated a
displaced starter weapon as evidence that the charm was awaiting equip, while the
core equip path allowed generated equipment to be equipped before the feature unlock.
That split let a boss-chest weapon replace the starter weapon before the charm step,
leaving the quest incomplete and preventing the staircase boss from starting.

## Decision

- **DEC-001**: During Floor 1, generated equipment cannot be equipped until the
  equipment feature unlock is set.
- **DEC-002**: Floor 1 AI maintenance defers boss-chest opening and generated-item
  processing until the shopkeeper quest is complete.
- **DEC-003**: The shopkeeper `awaiting-equip` stage recognizes only the canonical
  merchant charm, never an arbitrary static equippable item in the bag.
- **DEC-004**: Keep the existing static-loadout evaluator and weapon-class retention
  behavior so generated boss-chest upgrades remain usable after the unlock.

## Consequences

### Positive

- The real player and AI paths share the same Floor 1 equipment-unlock boundary.
- The charm quest cannot be falsely advanced by a displaced starter weapon.
- Boss-chest weapons remain available and class-compatible after progression unlocks.
- The behavior is covered by planner, core equipment, headless regression, and the
  authoritative Floor 1 completion gate.

### Negative

- Floor 1 boss-chest rewards may remain unopened in the bag until the shopkeeper
  sequence completes.
- Core equipment transfer now depends on the active Floor 1 scenario and unlock state.

### Risks

- Future Floor 1 quest changes could move the unlock boundary without updating the
  planner gate; progression tests must remain authoritative.
- A new static quest item must use an explicit stage check rather than broad
  equippable-item detection.

## Alternatives Considered

### Keep broad static-item detection

- **Description**: Continue treating any static equippable item in the bag as the
  merchant prize.
- **Rejection Reason**: Generated weapon replacement returns the starter weapon to
  the bag, causing a false `awaiting-equip` state and a progression deadlock.

### Gate only the AI planner

- **Description**: Prevent the planner from selecting generated equipment while
  leaving the shared equip system unchanged.
- **Rejection Reason**: The real player path and other AI callers could still equip
  generated equipment before the Floor 1 unlock.

### Remove boss-chest equipment upgrades

- **Description**: Avoid the deadlock by never replacing the starter weapon with a
  generated boss-chest weapon.
- **Rejection Reason**: This discards the intended class-compatible boss-chest
  upgrade behavior instead of fixing its progression ordering.
