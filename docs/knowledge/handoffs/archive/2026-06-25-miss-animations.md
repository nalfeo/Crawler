# Handoff: Miss Attack Animations

**Date:** 2026-06-25  
**Persona:** Game Designer  
**Complexity:** 🍎🍎 (estimated 🍎🍎, actual 🍎🍎)

## Systems touched

enemies

## What was done

Implemented the feature: combat misses now show swing/shoot animations.

### Problem

Previously, when the accuracy roll failed in `dispatchAttack`, the system immediately returned after pushing a `'miss'` combat event. No animation was played — the player got silent misses with just the floating "MISS" text.

### Solution

**`src/game/weaponSystem.ts`**

1. Added `rotateDir(dir, angleRad)` — 2-D rotation helper.
2. Added `deflectDirectionForMiss(world, dir)` — rotates the aim direction by ±30–60° using `world.rng` (deterministic). This is the "shoot wide" behaviour.
3. In `dispatchAttack`, the miss branch now fires cosmetic-only attacks with a `zeroDamageDef` (`{ ...def, baseDamage: 0 }`):
   - **MELEE**: calls `fireMeleeAttack` with 0 damage → swing arc plays normally, no HP loss.
   - **RANGED**: calls `fireRangedAttack` with deflected direction and 0 damage → projectile visibly sails wide.
   - **MAGIC**: same as RANGED (uses `fireRangedAttack` path with deflection).
   - **THROWN**: calls `fireThrownAttack` with deflected direction and 0 damage.
   - **BEAM/TRAP**: no cosmetic miss animation (unchanged).

**`src/core/systems/damageSystem.ts`**

Fixed `getDamageAmount` — previously fell back to `DEFAULT_PROJECTILE_DAMAGE` (10) when `Damage.amount === 0`, which would have made "0-damage" miss projectiles secretly deal 10 damage. Now it trusts the explicit 0 when the component is present. `applyDamage` already guards `amount <= 0 → return 0`, so miss projectiles are harmless on contact.

### Files changed

- `src/game/weaponSystem.ts` — miss cosmetic logic + helpers
- `src/core/systems/damageSystem.ts` — `getDamageAmount` fix
- `tests/game/melee-weapons.test.ts` — 2 new tests (miss swing spawned, 0-dmg swing doesn't hurt)
- `tests/game/ranged-weapons.test.ts` — 2 new tests (miss projectile fires wide, 0-dmg on contact)
- `tests/game/weapon-system-coverage.test.ts` — updated 1 test that expected no projectile on ranged miss

### Tests

299/299 passing.

## What's left / known limitations

- BEAM misses fire nothing (a "misfire" beam flash could be a future enhancement).
- TRAP misses fire nothing (trap placement already has its own audio/VFX).
- Magic (`MAGIC` type) uses `fireRangedAttack` for miss cosmetics rather than `fireMagicAttack` — this means the AOE indicator is skipped on miss, which is intentional (cleaner visually). If AOE miss animation is desired, add a separate `fireMagicMiss` helper.
- `world.rng` is consumed twice extra per ranged/thrown/magic miss (deflection magnitude + sign). No determinism regression since the world RNG sequence is already per-seed.
