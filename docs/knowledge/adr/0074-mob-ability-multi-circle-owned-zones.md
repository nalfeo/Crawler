# ADR 0074: Mob-ability multi-circle geometry + runtime-owned persistent zones

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 5 — touches core runtime/types plus game AI and engine rendering for one canonical boss-ability vertical slice.

## Context

The Sovereign Cap's **SOVEREIGN SPORE BLOOM** requires one committed telegraph
that resolves as **three locked circles** and then persists as toxic clouds for
4 seconds with deterministic repeated damage. The existing typed mob-ability
runtime only modeled a single committed circle and one-shot resolution effects.

## Decision

1. Extend `MobAbilityGeometry` from circle-only to a typed union supporting:
   - `circle`
   - `multi-circle`
2. Add runtime-owned persistent zones on `world.mobAbilities.ownedZones` with:
   - deterministic fixed-step ticking,
   - per-zone duration/interval,
   - ability-owned tick handlers,
   - lifecycle cleanup integrated with existing caster cleanup.
3. Keep ability behavior typed per handler (no generic `designValues`
   interpreter) by adding a dedicated `sovereign-spore-bloom` adapter/handler.
4. Make renderer and AI consume the same committed geometry and owned-zone
   geometry as runtime damage logic.

## Consequences

### Positive

- Supports authoritative multi-circle abilities without adding a boss-specific
  AI switch.
- Keeps telegraph, impact, persistent damage, renderer cues, and AI danger
  reasoning aligned on shared committed geometry.
- Reuses existing deterministic runtime and cleanup semantics.

### Negative

- Increases mob-ability runtime/type complexity versus circle-only model.
- Adds per-tick zone processing work for active persistent-zone abilities.

### Risks

- Future abilities could accidentally rely on renderer-specific handling unless
  they explicitly provide VFX coverage for their owned zones.
- Multi-zone/tick scaling may require optimization if many simultaneous zone
  casters are introduced.

## Alternatives Considered

1. **Ability-specific ad-hoc cloud system outside mob-ability runtime**  
   Rejected: duplicates lifecycle/cleanup logic and breaks typed-runtime
   convergence.
2. **Interpret generic catalog `designValues` at runtime**  
   Rejected: violates typed-handler policy and weakens compile-time contracts.
3. **Model persistent clouds as separate ECS hazard entities**  
   Rejected for this slice: larger surface-area change than needed for one
   ability; runtime-owned zones are smaller and deterministic with existing
   plumbing.
