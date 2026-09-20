# ADR 0108: Floor 3 automatic companion growth

## Status

Accepted

## Date

2026-09-20

## Estimated Complexity

🍎 x 3 — progression, automatic combat, and party presentation share one growth contract.

## Context

The human removed active companion commands from Floor 3's control model. The
existing command UI only maintained presentation cooldowns. Companion evolution
changed metadata but left spawned health, movement, range, and sprite scale
unchanged; combat used fixed damage. Species already author form scales and five
ability milestones, but their ability IDs have no bespoke effect definitions.

## Decision

- **DEC-001**: Remove command input, UI, state, tuning, and command labs. Agency
  remains movement, equipment, enabled automatic abilities, and party composition.
- **DEC-002**: Reuse species form `statScale` for HP and damage. Use its square
  root for movement speed, ranged reach, melee combat reach, and visible sprite
  size. Keep stored melee range zero because it is also the AI's melee marker.
- **DEC-003**: Scenario spawning and progression use the same pure growth
  resolver. Evolution rebases existing stats by next/previous growth ratios,
  preserving existing party HP bonuses and living health fraction. Keep fractional
  max HP rather than rounding at spawn so direct and incremental growth agree
  within the typed stores' floating-point precision. Dead/KO current HP is untouched.
- **DEC-004**: The existing companion combat system cycles learned attack
  profiles on successful automatic attacks, using its generation-protected local
  attack state and simulation time. Milestones 1/8/16/25/34 use damage/recovery
  multipliers 1/1, 1.1/0.9, 1.35/1.1, 1.6/1.2, and 1.8/1.25. The existing style
  determines melee or projectile delivery and affinity determines matchups.
  These are shared automatic techniques, not claims that species-specific novas,
  healing, or other roster flavor effects have been authored.
- **DEC-005**: Limit new growth and attack profiles to Floor 3. Floor 4+ kept
  companion behavior, Trainer implementation, and Studio order gates are excluded.
- **DEC-006**: Reuse bitecs, existing progression/KO systems, damage/projectile
  helpers, and the live `sprite.sizeScale` renderer path. No new system or
  dependency is warranted for a pure resolver and five static attack profiles.

## Consequences

### Positive

- **POS-001**: Learned abilities and evolution now affect actual automatic combat.
- **POS-002**: Runtime and headless simulation share the exact implementation.
- **POS-003**: No UI state or manual input can influence attack timing.

### Negative

- **NEG-001**: The generic attack profiles do not implement every species' authored
  flavor effect; that remains separate content work.
- **NEG-002**: Form growth changes Floor 3 combat outcomes; this PR verifies
  correctness and determinism rather than making a broad balance claim.

### Risks

- **RSK-001**: Ratio growth assumes independent stat changes remain multiplicative.
  Future additive companion equipment must define a base-stat recomputation seam.
- **RSK-002**: KO sentinel health, melee classification, entity reuse, and later
  floors require explicit regression coverage.

## Alternatives Considered

- **ALT-001**: Keep or repair manual commands. Rejected by explicit human decision.
- **ALT-002**: Add a separate ability ECS system or external combat framework.
  Rejected because existing deterministic targeting, damage, projectile, and
  cooldown primitives cover this bounded requirement without additional scheduling.
- **ALT-003**: Implement all 260 species-specific effects now. Rejected as outside
  the rehabilitation PR's bounded scope and lacking authored effect parameters.
