# Spec: Weapon System

> **Status:** Documents shipped behavior (reverse-engineered from code, verified
> against `src/game/weaponSystem.ts`, `src/shared/weaponDefs.ts`,
> `src/shared/constants.ts`, and the spawn helpers in `src/core/helpers.ts`).
> **Related ADRs:** 0009 (projectile max-range despawn), 0018 (weapon
> line-of-sight targeting), 0018 (fireball targeting), 0020 (projectile leading),
> 0023 (line-of-sight melee). **Related spec:** `combat-damage.md`.

## Context

Crawler is auto-fire: the player never aims manually. Each frame the weapon
system picks a target, decides hit/miss, and spawns the appropriate attack
entity, which later resolves through the single damage choke point
(`combat-damage.md`). Weapons are fully data-driven so balance lives in tables,
not code, and every outcome must be reproducible from a seed.

## Requirements

1. **Data-driven definitions.** Every weapon is a `WeaponDef` record in
   `WEAPON_DEFS` (`src/shared/weaponDefs.ts`); the system reads stats off the
   def and never hard-codes per-weapon numbers. 15 weapons ship today.
2. **Determinism.** Target leading, accuracy rolls, and miss deflection all draw
   from `world.rng` (`SeededRandom`). No `Math.random()`, no wall-clock — the
   cooldown gate uses `world.elapsedMs`.
3. **Cooldown gating.** A weapon may fire only when
   `world.elapsedMs - lastFireMs >= effectiveCooldownMs`, where
   `effectiveCooldownMs = applyAttackSpeedAndCooldownReduction(def.cooldownMs,
attackSpeedBonus, cooldownReduction)` (`shared/stats.ts`) —
   `def.cooldownMs / (1 + max(-0.9, attackSpeedBonus)) × (1 -
cooldownReduction)`, rounded once at the end (no early rounding between
   the two factors). On a successful fire, `lastFireMs` is set to
   `world.elapsedMs`.
4. **Targeting respects walls.** Auto-fire locks onto the nearest valid enemy
   that is within the weapon's gate range and either in the player's FOV or
   reachable by an unobstructed straight line (`world.floorMap.hasLineOfSight`).
   Corpses (entities with `DeathTimer`/non-positive HP) are skipped.
5. **One active attack per weapon.** The single-weapon path keeps at most one
   live melee swing per player; firing replaces the previous one.
6. **Accuracy is stat-modulated.** Effective hit chance is
   `clamp(0, 1, def.baseAccuracy + player accuracy stat)`; traps always hit.
7. **Misses are cosmetic, not free damage.** A missed attack emits a `miss`
   event and plays a zero-damage animation (deflected for projectiles); it
   grants no skill XP.

## Design

### Weapon taxonomy

`WeaponType` (`src/shared/constants.ts`) — note the value `2` is an intentional
gap:

| Type     | Value | Ships                                           |
| -------- | ----- | ----------------------------------------------- |
| `MELEE`  | 0     | sword, knife, hammer, baseball-bat, punch, kick |
| `RANGED` | 1     | pistol, bow, crossbow                           |
| `MAGIC`  | 3     | fireball                                        |
| `THROWN` | 4     | boomerang, throwing-knife, bowling-ball         |
| `BEAM`   | 5     | laser                                           |
| `TRAP`   | 6     | landmine                                        |

`MeleeStyle`: `SLASH = 0`, `STAB = 1`. `WEAPON_DEFS` is a
`ReadonlyMap<string, WeaponDef>`; `WeaponDef` carries per-type fields (`range`,
`projectileSpeed`, `aoeRadius`, `durationMs`, `beam*`, `trap*`, `returnSpeed`,
`maxRange`, `swingArcDeg`, `meleeStyle`, `headRadius`, `pierce`, `bounceCount`,
`knockback`, `goreFactor`, `baseAccuracy`, and the two skill IDs).

### Per-frame firing pipeline (`weaponSystem`, single active weapon)

1. **Cooldown gate** — bail unless
   `elapsedMs - lastFireMs >= effectiveCooldownMs` (see Requirement 3 for the
   attack-speed/cooldown-reduction formula).
2. **Target selection** — `getWeaponGateRangeFt(def)` sets the search radius by
   type (melee → `max(aoeRadius, range)`; beam → `max(beamLength, range)`; trap →
   `max(trapTriggerRadius, trapExplosionRadius, range)`; thrown →
   `maxRange || range`; ranged/magic → `range`). Among enemies inside that gate,
   pick the **nearest** that passes the FOV-or-LOS visibility test and is not a
   corpse. **Boss priority:** a permanently-aggroed Floor 1 boss (elite marker)
   within range and with line of sight is preferred over nearer adds.
3. **Leading** — for `RANGED`/`MAGIC`/`THROWN`, `computeLeadDirection` solves the
   intercept so fast projectiles lead a moving target (ADR 0020). Melee, beam,
   and trap fire straight at the target.
4. **Accuracy roll** — `computeEffectiveAccuracy = TRAP ? 1.0 :
clamp(0, 1, def.baseAccuracy + effectiveStats.accuracy[player])`. Miss when
   `world.rng.next() > effectiveAccuracy` (a roll exactly at the threshold is a
   hit).
   - On a miss: emit a `miss` event; play a zero-damage cosmetic attack. Ranged/
     magic/thrown are deflected by a random ±30°–60° (`deflectDirectionForMiss`,
     `MISS_DEFLECT_MIN_RAD = π/6`, `MISS_DEFLECT_MAX_RAD = π/3`); beam/trap skip
     the animation. No skill XP.
5. **Dispatch** — on a hit, register the weapon's skill IDs in
   `world.attackerWeaponSkills` (keyed by player) as a legacy/fallback source,
   then spawn the attack entity and register that spawned EID in
   `world.attackWeaponSkillsByEntity`. Damage systems prefer the per-attack map
   so delayed hits keep the weapon that spawned them even after later weapon
   switches. This is also the single choke point that tags the spawned attack
   entity's `DamageMeta` (`origin: 'player'`, `affinity: def.weaponType ===
WeaponType.MAGIC ? 'magic' : 'physical'`, `scaleWithPrimary: true`,
   `canCrit: true`) — see `combat-damage.md` for how the collision system
   consumes it.

### Spawn helpers (`src/core/helpers.ts`)

`dispatchAttack` routes by type to the matching spawner:

| Type   | Spawner                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| MELEE  | `spawnMeleeSwing` (arc/stab governed by `swingArcDeg`, `meleeStyle`, `headRadius`) |
| RANGED | `spawnProjectile` (or `spawnBouncingProjectile` when `bounceCount > 0`)            |
| MAGIC  | `spawnAoeProjectile` (impact AoE of `aoeRadius`)                                   |
| THROWN | `spawnReturningProjectile` (boomerang) or `spawnProjectile`                        |
| BEAM   | `spawnBeam` (length `beamLength`, repeats every `beamTickMs` for `durationMs`)     |
| TRAP   | `spawnTrap` (arms after `trapArmMs`, triggers in `trapTriggerRadius`)              |

Returning projectiles travel outbound until `maxRange²`, then flip to
`isReturning = 1`, set `pierce = 255`, and steer back toward the owner. Projectile
despawn at max range follows ADR 0009.

### Single vs multi-weapon

`weaponSystem` drives the **one active player weapon** (`setActiveWeapon` /
`getActiveWeapon`). A separate path handles entities that own multiple weapons.
Both share the same `elapsedMs - lastFire >= effectiveCooldownMs` gate and
accuracy model.
`emitWeaponSkillEvents` records a `weapon_fired` metric for telemetry.

## Test Plan

| Concern                                         | Suite                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Cooldown gate, target selection, accuracy clamp | `tests/game/weapon-system.test.ts`, `tests/game/weapon-system-coverage.test.ts`                           |
| Per-type behavior                               | `tests/game/{melee,ranged,magic,thrown,beam,trap}-weapons.test.ts`                                        |
| Projectile leading                              | `tests/game/weapon-leading.test.ts`                                                                       |
| Skill attribution / XP on hit                   | `tests/game/weapon-skills.test.ts`                                                                        |
| Full fire → collision → damage pipeline         | `tests/integration/weapons-pipeline.test.ts`                                                              |
| Beam/trap/returning/cleanup branches            | `tests/ecs/{beam-system-branches,trap-system,projectile-cleanup,melee-returning-system-coverage}.test.ts` |
| Behavioral sensors                              | `tests/sensors/weapons.test.ts`                                                                           |

Required invariants to keep covered:

- Same seed ⇒ identical target choice, hit/miss sequence, and spawn outputs.
- A weapon never fires before its cooldown elapses.
- Auto-fire never targets an enemy with no line of sight (e.g. behind a locked
  boss door).
- Traps always pass the accuracy gate; ranged misses are visibly deflected and
  deal no damage.

Build worlds with `createTestWorld({ seed: 42 })`; never construct one manually.

## Constitutional Compliance

- **Deterministic ECS:** all randomness via `world.rng`; cooldowns via
  `world.elapsedMs`; no `Date.now()`/`Math.random()`. ✅
- **Layer purity:** the weapon system lives in `src/game/`, spawn primitives in
  `src/core/`; defs in `src/shared/`. No Phaser imports; VFX is driven by the
  data-only event stream. ✅
- **Lab-gated:** weapon behavior is exercisable in the `src/labs/` weapon
  sandboxes alongside its game/ecs/integration suites. ✅
- **Data-driven balance:** tuning lives in `WEAPON_DEFS`; this spec documents the
  contract without restating per-weapon numbers.
