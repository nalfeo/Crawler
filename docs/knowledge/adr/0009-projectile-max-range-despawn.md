# ADR 0009: Projectile Max Range Despawn Rules

## Status

Accepted

**Date:** 2026-06-09  
**Deciders:** Systems Engineer

## Context

Players and weapons can fire projectiles of various types (ranged, magic, thrown, bouncing). Currently, projectiles persist until they hit walls, bounds, or other game events. Gameplay feedback indicated that all projectiles should have a maximum range/distance where they despawn by default, **except** returning/boomerang weapons which should be allowed to travel beyond max range if they can still return to their owner.

This introduces a new rule: projectile lifespan is now constrained by both spatial events (walls, bounds) and range distance (except for returning weapons).

## Decision

We implement max range despawn as follows:

1. **Add range tracking to Projectile component** (`maxRange`, `originX`, `originY`)
2. **Update all projectile spawn helpers** to accept optional `maxRange` parameter
3. **Implement distance-based despawn** in `projectileCleanupSystem` for non-returning projectiles
4. **Update weaponSystem** to pass range/maxRange from weapon definitions
5. **Preserve returning projectile behavior** by skipping Projectile-level max range for entities with Returning component

### Key Semantics

- **maxRange=0**: Unlimited range (no distance-based despawn)
- **maxRange > 0**: Projectile despawns when distance > maxRange
- **Returning projectiles**: Use their own Returning.maxRange field, exempt from Projectile-level despawn check
- **Distance calculation**: Squared Euclidean distance to avoid sqrt overhead

## Consequences

### Positive

- Consistent range behavior across all weapon types
- Reduces projectile clutter for weapons with unbounded range
- Clear separation of concerns: Projectile component handles regular despawn, Returning component manages boomerang behavior
- Backward compatible: default maxRange=0 preserves existing behavior for code that doesn't specify range
- Minimal overhead: distance check is only one squared-distance calculation per projectile per frame

### Negative

- Adds 3 fields to Projectile component (small memory overhead per projectile)
- Slightly more complex cleanup logic (but still O(1) per projectile)
- Weapon definitions now need explicit range values (but most already have them)

### Risks

- If weapon definitions don't set maxRange, projectiles will have unlimited range by default (safe fallback, but may not match intended gameplay)
- Wall blocking during return phase is not currently checked; boomerangs can pass through walls on return (acceptable for MVP, future enhancement possible)

## Alternatives Considered

1. **Add maxRange only to Returning component**: Rejected because non-returning projectiles also need range limits
2. **Use different system for each projectile type**: Rejected as overly complex; unified cleanup is simpler
3. **Track time-to-live instead of distance**: Rejected because range-based despawn better matches weapon design (range is a core weapon property)
4. **Calculate exact distance (sqrt)**: Rejected in favor of squared distance for performance

## Implementation Notes

- All unit conversions happen at weaponSystem boundary (feet -> pixels via ftToPx)
- Origin position (spawn location) is set once and never updated
- Non-returning check uses explicit guard: `!isReturning`
- Test coverage includes boundary cases (exactly at max range, diagonal distance, unlimited range)

## References

- Implements feedback request: "All weapons/projectiles need a max range/distance where they despawn by default"
- Related systems: projectileCleanupSystem, weaponSystem, Returning component
- Test file: tests/ecs/projectile-cleanup.test.ts
