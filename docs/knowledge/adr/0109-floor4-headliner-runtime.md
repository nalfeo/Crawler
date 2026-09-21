# ADR 0109: Floor 4 Headliners use the shared ability runtime

## Status

Accepted

## Date

2026-09-21

## Estimated Complexity

🍎 x 5 — catalog, deterministic combat, encounter lifecycle, geometry, and dual-pipeline evidence.

## Context

Floor 4 validates nine signature abilities but discards the catalog and never binds
them to spawned Headliners. Both production runners already execute the shared
mob ability phase machine. Floor 4 FR3.7 requires encounter-owned summons to count
against the arena cap without entering scheduled wave manifests or spawn debt.

## Decision

- **DEC-001**: Retain the validated catalog and adapt each entry into a typed
  definition. Reuse the existing bitecs runtime, status effects, projectiles and
  owned zones rather than introduce another state machine or dependency.
- **DEC-002**: Register and activate on the shared scenario's Headliner spawn.
  Preserve clocks through overtime; disable on defeat or encounter exit. Opt-in
  generation-checked summoned-entity cleanup leaves other floors' behavior intact.
- **DEC-003**: Commit cone and contracting-annulus geometry once. Rendering,
  damage and AI use those same shapes. The ring's final band remains visible
  throughout contraction. Self auras alone follow their caster.
- **DEC-004**: Author the five finale add archetypes in the manifest. Select their
  order from the continuation of the isolated Headliner stream. The scenario
  spawns only passable committed marks with available hostile capacity, counting
  the boss. Skipped marks create no debt or delayed untelegraphed spawn.
- **DEC-005**: Map qualitative moderate/heavy damage to one/1.5 times the existing
  per-act contact damage (including overtime). Short/medium shoves use two/four
  feet; unspecified slow strength uses the existing 20% movement reduction.
  These are explicit initial runtime mappings, not a wave or gear rebalance.
- **DEC-006**: Sentinel uses an optional incoming damage multiplier in the existing
  active buff state, applied at the common damage boundary after offense scaling.
  Its 35% reduction and knockback resistance expire together after four seconds.

## Consequences

### Positive

- **POS-001**: MainGameScene, headless and labs share registration and execution.
- **POS-002**: Existing cooldown, announcement and generation ownership rules apply.

### Negative

- **NEG-001**: New geometry extends renderer and avoidance consumers.
- **NEG-002**: Activating authored attacks changes encounter difficulty; tuning is
  explicitly deferred to later rehabilitation PRs.

### Risks

- **RSK-001**: Stale summon ownership can delete recycled entities; teardown must
  validate generations and remove registration before recursive store cleanup.
- **RSK-002**: Presentation-only tests miss runtime wiring; every Headliner needs
  production pipeline evidence in addition to focused hit/counterplay tests.

## Alternatives Considered

### Scene-specific effects

- **ALT-001**: Rejected because headless would diverge from the real scene.

### External ability or state-machine framework

- **ALT-002**: Rejected because the existing fixed-step bitecs executor already
  provides the required timing, status ownership and test seams without adapters
  to a second scheduler or new dependencies.

### Treating adds as arena waves

- **ALT-003**: Rejected because wave debt and phase cuts violate encounter ownership.
