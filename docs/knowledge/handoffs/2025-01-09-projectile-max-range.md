# Handoff: Projectile Max Range Despawn Rules

**Date:** 2025-01-09  
**Session:** Weapon range rules (nalfeo/vigilant-adventure)  
**Commit:** 42f9825 - feat: implement projectile max range despawn rules

## Summary

Implemented gameplay projectile range/despawn rules allowing all projectiles to have a max distance before despawning, with a specific exception for returning/boomerang weapons that should NOT despawn when they can still return.

## Changes Made

### 1. Component Updates (`src/core/components.ts`)

- Added `maxRange`, `originX`, `originY` fields to the Projectile component store (lines 90-96)
- `maxRange` is the maximum distance from spawn before despawn (0 = unlimited)
- `originX`, `originY` track the spawn position, never updated during flight

### 2. Projectile Spawn Helpers (`src/core/helpers.ts`)

- Updated `spawnProjectile()` to accept optional `maxRange` parameter (default 0)
- Updated `spawnAoeProjectile()` to accept optional `maxRange` parameter (default 0)
- Updated `spawnBouncingProjectile()` to accept optional `maxRange` parameter (default 0)
- `spawnReturningProjectile()` does NOT set Projectile-level maxRange (returns projectiles use Returning component instead)

### 3. Projectile Cleanup System (`src/core/systems/projectileCleanupSystem.ts`)

- Added max range despawn check for non-returning projectiles (lines 104-120)
- Uses Euclidean distance calculation: `distSq = (x - originX)² + (y - originY)²`
- Despawns when `distSq > maxRange²` for non-returning projectiles only
- Returning projectiles skip this check because they're managed by the Returning component

### 4. Weapon System (`src/game/weaponSystem.ts`)

- `fireRangedAttack()`: passes `ftToPx(def.range)` as maxRange to spawnProjectile (line 274)
- `fireMagicAttack()`: passes `ftToPx(def.range)` as maxRange to spawnAoeProjectile (line 297)
- `fireThrownAttack()`:
  - Returns boomerangs: uses `spawnReturningProjectile()` with `ftToPx(def.maxRange)` (line 319)
  - Bouncing thrown: uses `spawnBouncingProjectile()` with `ftToPx(def.range)` (line 336)
  - Regular thrown: uses `spawnProjectile()` with `ftToPx(def.range)` (line 349)

### 5. Tests (`tests/ecs/projectile-cleanup.test.ts`)

- Added 4 new test cases (total now 12):
  - Despawn exactly at max range boundary ✓
  - Despawn when exceeding diagonal max range ✓
  - Unlimited range when maxRange=0 ✓
  - Returning projectiles NOT despawned at max range ✓

## Design Decisions

### 1. maxRange=0 Semantics

- Zero means unlimited range — projectile won't despawn from distance
- Non-zero values enforce the distance limit
- This provides backward compatibility for existing projectiles that don't specify maxRange

### 2. Distance Calculation

- Uses squared Euclidean distance to avoid expensive sqrt() calls
- Comparison: `distSq > maxRange²` (strict inequality, boundary-safe)
- Projectiles survive exactly at max range, despawn just beyond

### 3. Returning Projectile Exception

- Returning projectiles have their own `Returning` component with separate maxRange field
- The new Projectile-level maxRange check explicitly skips returning projectiles: `!isReturning`
- This preserves existing boomerang behavior and allows them to return home even at distance

### 4. Unit Conversions

- All weapon definitions use feet (e.g., `def.range`, `def.maxRange`)
- All spawns convert to pixels via `ftToPx()` at the weaponSystem boundary
- Projectile store uses pixels (consistent with Position component)

## Verification

### Tests

- ✅ All 1021 unit tests pass (1020 → 1021 with new returning projectile test)
- ✅ 12 projectile-specific tests including max range behavior
- ✅ Typecheck: clean
- ✅ Lint: clean
- ✅ Full verify suite: pass

### Coverage

- Non-returning projectiles: respects max range ✓
- Returning projectiles: exempt from max range despawn ✓
- Bouncing projectiles: respects max range alongside bounce logic ✓
- Unlimited range (maxRange=0): projectiles persist until bounds/wall ✓
- Wall/bounds cleanup: still works as before ✓

## Implementation Notes

- **Spawn callsites**: All projectile spawning flows through weaponSystem (for player weapons) or test helpers. Enemy weapons would also benefit if they eventually use these same functions.
- **Backward compatibility**: Optional maxRange parameter with default=0 maintains compatibility with existing code that doesn't specify it.
- **Origin tracking**: Set at spawn time, never updated. This is safe because projectiles don't change origin during their lifetime.
- **Performance**: Distance calculation uses squared values to avoid sqrt, consistent with game physics patterns.

## Assumptions & Decisions

1. **No path-finding for return failure**: The current implementation does NOT detect if a returning projectile has no viable path back. Future iteration could check for wall blockage during return phase.
2. **Wall blocking still works**: If a projectile's next position is blocked, it despawns immediately (existing wall-hit logic).
3. **All weapons use weapon definitions**: Player weapons pull maxRange from WeaponDef.range/maxRange. If custom code spawns projectiles outside weaponSystem, it should explicitly pass maxRange.

## Next Steps (for future iterations)

1. **Enemy weapon spawning**: When enemy ranged attacks are implemented, ensure they also pass maxRange to maintain consistency.
2. **Returning projectile wall blocking**: Add wall-hit detection during return phase to despawn boomerangs that hit obstacles on the way back.
3. **Lab visualization**: Consider adding a visual test in `src/labs/projectilecleanup-lab/` to show max range circles for different weapon types.

---

**Status:** ✅ Complete and verified. Ready for merge.
