# ADR: Generated-equipment carryover authority

## Status

Accepted

## Date

2026-07-21

## Estimated Complexity

🍎 x 3 — touches `src/core`, `src/game`, and `src/engine` carryover seams without adding a new ECS system

## Context

The Floor 1 → Floor 2 restart path now carries generated-equipment identity,
registry state, active-weapon snapshots, grants, reward bundles, and the run key
through a fresh Floor 2 world.

That cross-layer path exposed one important authority rule: generated active
abilities can be _known but inactive_ when the active-slot cap is full. If the
carryover snapshot strips those generated grant-source records and relies on
equip replay alone, the restore order can silently choose a different active
subset on Floor 2 than the player had on Floor 1.

## Decision

1. The carryover snapshot remains value-only, but it preserves
   `generated-equipment` entries in `activeAbilityGrantSources`.
2. Static `equipment` grant sources are still stripped from carryover snapshots.
3. Passive equipment grants continue to be rebuilt from replay rather than
   serialized as carried source-tracking state.
4. Generated-equipment replay must remain idempotent for the exact
   `(instanceId, effectOrdinal)` pair so restored source-tracking state and later
   re-equip do not duplicate or reshuffle active abilities.

## Consequences

### Positive

- Carryover preserves the player's exact generated active/inactive ability
  selection instead of recomputing it from replay order.
- The snapshot still avoids serializing static item-instance authority.
- Existing generated-equipment equip replay stays the single mutation path after
  the value snapshot is restored.

### Negative

- Carryover validation must distinguish allowed generated active sources from
  disallowed static equipment or passive equipment sources.

### Risks

- If a future generated active-grant source shape stops being idempotent, replay
  could duplicate or overwrite the restored selection.
- Omitting future generated active-grant metadata from carryover would re-open
  replay-order drift.

## Alternatives Considered

### Recompute the active subset from equip replay only

- **Rejected**: replay order depends on equipped-slot iteration order, so a
  previously known-inactive generated ability can become active after carryover.

### Serialize all equipment grant sources, active and passive

- **Rejected**: static item-instance authority still belongs to the normal
  equip pipeline, and passive equipment effects already have a safe replay path.
