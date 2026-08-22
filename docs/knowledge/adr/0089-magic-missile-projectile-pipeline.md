# ADR 0089: Magic Missile uses the shared projectile pipeline

## Status

Accepted

## Date

2026-08-22

## Estimated Complexity

🍎 x 4 — deterministic core simulation, spell progression, runtime lighting, and visual regression coverage change together.

## Context

Magic Missile needed visible, trackable travel rather than applying damage at cast time. It must arc outward, home toward a living enemy, add missiles at skill milestones without raising per-hit damage at those milestones, emit an impact at the true contact point, and illuminate the real game scene while in flight.

The core simulation owns movement, collision, damage, and entity lifetime. The game layer owns spell output and progression. The engine owns light-field rendering. Keeping a separate Magic Missile damage path would make those layers disagree about collision, attribution, cleanup, and visual timing.

## Decision

Use the existing projectile spawn, movement, collision, damage, and cleanup pipeline for Magic Missile. Add deterministic `Homing` and `Glowing` component data:

- **DEC-001**: `homingSystem` preserves a short launch heading, then turns at a bounded rate toward the assigned or retargeted living enemy.
- **DEC-002**: Magic Missile milestone levels 5/10/15/20 add a bolt only; non-milestone levels supply its per-hit efficacy progression.
- **DEC-003**: `Glowing` entities become dynamic engine light sources for their lifetime, while impact VFX reads the projectile position before destruction.
- **DEC-004**: The real MainGameScene probe casts a live bolt and observes its computed light contribution before and after impact.

## Consequences

### Positive

- **POS-001**: Spell damage resolves through the same collision and attribution lifecycle as other projectiles.
- **POS-002**: Homing, cleanup, retargeting, and the visible light source remain deterministic in game and headless simulation paths.
- **POS-003**: Runtime e2e coverage catches a disconnected dynamic-light wiring path.

### Negative

- **NEG-001**: A cast can miss or be delayed by travel time instead of resolving instantly.
- **NEG-002**: The engine recomputes its dynamic-light source key as each bolt moves.

### Risks

- **RSK-001**: Extremely dense simultaneous projectile casts can add light-field source work; the existing camera-scoped field and source cache bound the cost.
- **RSK-002**: Changing the generic projectile timing can affect this spell’s perceived balance, so its speed remains intentionally below existing ranged projectile speeds.

## Alternatives Considered

### Instant spell damage plus cosmetic bolt

- **ALT-001**: **Description**: Deal damage at cast time and render a non-authoritative traveling effect.
- **ALT-002**: **Rejection Reason**: The visible impact, damage timing, and target state can diverge, and a cosmetic bolt cannot retarget or participate in collision cleanup.

### Magic-Missile-specific movement and hit system

- **ALT-003**: **Description**: Add a parallel spell-only ECS path for movement, collision, and damage.
- **ALT-004**: **Rejection Reason**: It duplicates the established projectile lifecycle and increases the chance that spell attribution, collision rules, and cleanup drift from weapons.

### Static light attached to the caster

- **ALT-005**: **Description**: Brighten the caster while Magic Missile is active.
- **ALT-006**: **Rejection Reason**: It does not illuminate the bolt’s actual position and fails the moving-light requirement.
