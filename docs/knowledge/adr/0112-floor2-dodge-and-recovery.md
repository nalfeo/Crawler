# ADR 0112: Floor 2 dodge priority and recovery drops

## Status

Accepted

## Date

2026-09-26

## Estimated Complexity

Touches AI movement and existing combat/loot pipelines; no new ECS system.

## Context

The player AI can blend a visible danger escape with pursuit, while fixed melee
spacing treats large bosses as point targets. The user requested active dodging,
boss-body clearance, and 1% regular / 50% boss potion drops healing 10% max HP.

## Decision

- **DEC-001**: Floor 2 imminent dodge input takes priority over reward/pursuit
  blending and smoothing. Use public committed geometry and physical body size.
- **DEC-002**: Respect large enemy bodies in Floor 2 player approach and melee
  hit testing, without increasing enemy melee reach or changing other floors.
- **DEC-003**: Reuse Health Vial dropped items, seeded death rolls, collision
  pickup, and existing feedback. Potions heal on contact, capped at max HP;
  full-health or dead players leave them on the ground. AI ignores unusable vials.
- **DEC-004**: The user subsequently approved completing and activating all 18
  signature abilities. Reuse the existing typed executor, owned hazards and
  self-buffs; the descriptive catalog is not an executable DSL. Register each
  boss only at its encounter-start transition. Activate the global runtime once,
  without resetting other active encounters; cleanup remains caster-local.
- **DEC-005**: Add exact annulus, composite, and sweeping-arc public geometry.
  Sample moving owned hazards every simulation frame before damage, using a
  clamped elapsed time. Rendering and AI consume that same current geometry.
  Preserve the existing Floor 4 contracting-annulus semantics.
- **DEC-006**: Tune boss durability only with abilities enabled, preserving the
  existing first-cast minimum and 45-second maximum survival-test bounds.

## Consequences

### Positive

- **POS-001**: Shared simulation systems give human and AI players identical healing.
- **POS-002**: No new dependencies, ECS component, inventory UI, or random source.

### Negative

- **NEG-001**: Additional Floor 2 RNG draws intentionally change historical run traces.
- **NEG-002**: Dodging can temporarily reduce damage output.

### Risks

- **RSK-001**: Movement/hit-test changes require final-input and pipeline regressions;
  body-aware melee must preserve broad-phase parity and avoid enemy reach buffs.
- **RSK-002**: Encounter activation must not reset another boss's clocks or erase
  its hazards. Tests cover dormant bosses, repeated casts, ownership cleanup,
  and public geometry parity across simulation, AI, and rendering.

## Alternatives Considered

- **ALT-001**: Increasing player HP hides avoidance defects; rejected.
- **ALT-002**: Manual consumable inventory adds controls outside this request; rejected.
- **ALT-003**: A new movement framework is unnecessary; extend the existing seeded AI.
- **ALT-004**: Replacing the existing bitecs ability executor with an external
  state-machine or physics package adds migration and determinism risk without
  filling a missing capability. Small typed adapters fit the established runtime.
