# ADR: Core stat scaling metadata + `weight` primary-stat placeholder

## Status

Accepted

## Date

2026-07-10

## Estimated Complexity

🍎🍎 — shared stat-table changes plus core-store/UI/test wiring, finished with a small merge-conflict reconciliation against `main`.

## Context

This branch retunes part of the core-stat metadata surface:

- strength now contributes a displayed `damageBonus` rate of `+1.0%` per point,
- dexterity's direct/allocation metadata is aligned with its existing `+1.0%` accuracy contribution,
- wisdom now contributes a displayed `cooldownReduction` rate of `+0.5%` per point.

The same branch also reserves `weight` as a future-facing primary stat. Slice-2 size/weight work already established gameplay-facing entity weight, but the player/core-stat schema did not yet have a first-class placeholder for future momentum / knockback-facing progression work.

Because the branch touches `src/shared/`, `src/core/`, `src/engine/`, and tests, the decision crosses multiple layers and needs an ADR-sized record.

## Decision

1. **Reserve `weight` in the core stat schema now.**
   - Add `weight` to `PRIMARY_STATS`, clamps, defaults, and `CORE_STAT_BASE`.
   - Extend the ECS typed-array stores (`baseStats`, `effectiveStats`, `coreStatPoints`) so the runtime schema is complete even before gameplay consumers are added.
2. **Keep `weight` non-allocatable in the shipped level-up UX.**
   - Surface it in display metadata so the schema is explicit.
   - Keep the plus-button / keyboard allocation path disabled so players cannot spend points on a stat with no active progression loop yet.
3. **Align the display + derivation metadata for the requested stat tuning.**
   - Strength advertises `damageBonus: 0.01`.
   - Wisdom advertises `cooldownReduction: 0.005`.
   - Accuracy metadata is kept at `0.01` to match dexterity's contribution.
   - Derived-stat formatting treats the tuned fields as percentage-labeled summaries in the level-up surface.
4. **Lock the new shape in with tests.**
   - Expand effective-stat expectations for the new strength/wisdom derivations.
   - Expand UI/wiring tests so `weight` stays visible-but-disabled instead of silently becoming allocatable later.

## Consequences

### Positive

- The stat schema is now forward-compatible with future player-facing weight mechanics.
- The level-up and stat-summary surfaces describe the tuned rates consistently instead of leaving them implicit.
- Core typed-array stores, shared definitions, and tests all agree on the expanded primary-stat shape.

### Negative

- `weight` is now visible in the data/UI contract even though it is intentionally inactive for allocation.
- The branch broadens metadata/UI expectations without adding new downstream consumers for every tuned stat path.

### Risks

- Future work must keep the placeholder contract honest: `weight` should stay disabled until a real progression effect exists.
- Follow-up gameplay work should verify that any displayed percent-derived stat is consumed consistently in the relevant combat/cooldown paths before promising behavior beyond the current metadata/test surface.

## Alternatives Considered

- **Keep `weight` out of primary stats until gameplay use exists** — rejected because it would leave the player stat schema incomplete relative to the planned size/weight work and delay the required store/UI wiring.
- **Add `weight` to the schema but hide it entirely from the UI** — rejected because the branch goal was an explicit placeholder, not a hidden private field.
- **Delay the stat-scaling metadata tune until every consumer path was updated** — rejected for this branch because the requested scope was to tune the core-stat tables and reserve the placeholder first, with behavior-level follow-up able to land separately.
