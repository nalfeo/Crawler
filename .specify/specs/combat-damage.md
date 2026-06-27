# Spec: Combat & Damage

> **Status:** Documents shipped behavior (reverse-engineered from code, verified
> against `src/core/apply-damage.ts` and `src/core/systems/damageSystem.ts`).
> **Related ADRs:** 0017 (corpse collision guard), 0018 (secondary stats into
> combat), 0023 (line-of-sight melee & loot reachability), 0027 (corpse
> explosion on hit). **Related spec:** `stats-skills-levels.md`.

## Context

Every point of damage in Crawler — player projectiles, enemy projectiles, melee
swings, AoE, beams, and enemy contact — must resolve through one deterministic
path so that combat is reproducible from a seed, secondary stats (crit/dodge)
apply uniformly, and the renderer can react to a single, data-only event stream.

Two concerns are deliberately separated:

- **Policy** — _who may damage whom, and how much reaches the target_:
  invincibility frames, armor mitigation, projectile pierce, safe-space
  immunity, and contact-damage throttling. Lives in
  `src/core/systems/damageSystem.ts`.
- **Mechanism** — _applying an already-decided amount to one target_: the
  validate → dodge → crit → overkill-clamp → emit pipeline. Lives in the single
  choke point `applyDamage()` in `src/core/apply-damage.ts`.

This split keeps the mechanism reusable (any system can call `applyDamage`) while
the policy stays in the collision-driven system.

## Requirements

1. **Single choke point.** All HP reduction flows through `applyDamage()`. No
   system writes `world.stores.health.current` directly to deal damage.
2. **Determinism.** Every random outcome (crit, dodge) draws from `world.rng`
   (`SeededRandom`); the same seed + inputs yields identical combat. No
   `Math.random()`, no wall-clock reads.
3. **Pure roll helpers.** Crit/dodge decisions are pure functions
   (`resolveCrit`, `resolveDodge`) that take a roll in `[0, 1)` and never touch
   the RNG themselves, so they are unit-testable without a world.
4. **No negative / overkill HP.** Damage dealt is clamped to the target's
   remaining HP; HP never goes below 0.
5. **Direction of damage is inferred from the target type.** An enemy target ⇒
   player-sourced (eligible for crit); a player target ⇒ enemy-sourced (eligible
   for dodge). Neither path requires the attacker entity.
6. **Graceful degradation.** On a bare world without `EffectiveStats`/`Stats`
   stores (e.g. a minimal test world), no rolls fire and no armor is applied —
   behavior stays deterministic and roll-free.
7. **Data-only events.** Combat emits `CombatEvent`s onto `world.combatEvents`
   for the engine to render; the core layer never imports Phaser.
8. **Player survivability gates.** Player damage is gated by armor mitigation and
   250 ms invincibility frames; a player inside a safe space takes no damage.

## Design

### `applyDamage()` pipeline (mechanism)

`applyDamage(world, target, amount, x, y, weaponGoreFactor?, sourceX?, sourceY?) → dealt`

Executes in this exact order:

1. **Validate** — if `amount` is non-finite or `≤ 0`, return `0` (no event).
2. **Invincible guard** — if the target has `Invincible`, return `0`.
3. **Corpse-explosion guard** — if the target is an `Enemy` still in its
   death-linger window (`DeathTimer.remainingMs > 0`), emit a `corpseExplode`
   event, zero the death timer (reaped later this frame), and return `0`. A
   corpse bursts into shards instead of soaking the blow (ADR 0027 / 0017).
4. **Dodge** (player target only, requires `EffectiveStats`) — roll
   `resolveDodge(world.rng.next(), dodgeChance)`. On success, emit a `dodge`
   event and return `0`.
5. **Crit** (enemy target only) — read the player singleton's
   `critChance`/`critMultiplier` from `EffectiveStats` and roll
   `resolveCrit(world.rng.next(), amount, critChance, critMultiplier)`; a crit
   scales the amount.
6. **Overkill clamp** — `dealt = min(currentHP, finalAmount)`; subtract from HP.
7. **Emit** — if `dealt > 0`, push a `hit` event (carrying `targetType`,
   `isCrit`, `weaponGoreFactor`, and source position for directional gore).

Returns the actual damage dealt (used by callers for skill-XP attribution, etc.).

### `damageSystem()` (policy)

Runs once per frame over the `CollisionResult` pairs and dispatches by collision
kind, applying policy before delegating to `applyDamage`:

| Interaction               | Policy applied                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| Player projectile → enemy | safe-space (destroy projectile instead), pierce tracking, skill-XP on hit      |
| Enemy projectile → player | safe-space immunity, armor reduction, i-frames, then destroy projectile        |
| Enemy contact → player    | corpse deals no contact damage, safe-space immunity, armor reduction, i-frames |

Key policy constants (`src/core/systems/damageSystem.ts`):

- `PLAYER_INVINCIBILITY_MS = 250` — after a hit lands, further player damage is
  blocked for 250 ms; blocked attempts emit a throttled `blocked` event (at most
  one per window).
- `DEFAULT_PROJECTILE_DAMAGE = 10`, `DEFAULT_CONTACT_DAMAGE = 5` — fallbacks when
  no `Damage` component is present.
- **Armor:** `applyArmorReduction` ⇒ `max(1, raw - armor)` from `Stats.armor`
  (player incoming hits only; a hit always does at least 1).
- **Pierce:** a per-projectile hit-set prevents double-hitting the same enemy;
  when `hitCount > pierce` the projectile is destroyed, unless it is `Returning`
  (then `isReturning = 1`, `pierce = 255`, `hitCount = 0`).

### Secondary-stat derivation

`critChance`/`dodgeChance`/`critMultiplier` are not authored directly — they are
derived from primary stats by `src/core/effective-stats.ts` via
`CORE_STAT_TO_SECONDARY` (e.g. Luck → crit, Dexterity → dodge) and then clamped
by `clampStat` (`src/shared/stats.ts`). The damage path reads them straight off
`EffectiveStats`, which is what makes level-up allocation reach combat (ADR
0018). See `stats-skills-levels.md` for the stat tables and clamp ranges.

### Combat events

`CombatEvent` (`src/shared/combat-events.ts`) is a data-only struct consumed by
the engine VFX layer. Event `type` is one of:
`hit | blocked | death | miss | dodge | corpseExplode`. Events carry target
position, `targetType`, `timestamp` (`world.elapsedMs`), and optional gore
metadata (`weaponGoreFactor`, `sourceX/Y`, `bloodColor`, `isCrit`,
`spriteTextureId`).

## Test Plan

| Concern                                                         | Suite                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pure crit/dodge math (roll thresholds, multiplier, zero-chance) | `tests/unit/combat-rolls.test.ts`                                             |
| `applyDamage` order, guards, overkill clamp, event emission     | `tests/ecs/apply-damage.test.ts`                                              |
| `damageSystem` dispatch, armor, i-frames, pierce, safe-space    | `tests/ecs/damage-system.test.ts`, `tests/ecs/damage-system-branches.test.ts` |
| Area/AoE damage branches                                        | `tests/ecs/area-damage-system-branches.test.ts`                               |

Required invariants to keep covered:

- Identical seed + identical inputs ⇒ identical HP outcomes and event stream.
- HP never drops below 0; `dealt` never exceeds remaining HP.
- A bare world (no `EffectiveStats`/`Stats`) applies no rolls and no armor.
- I-frames: a second hit inside 250 ms deals no damage and emits at most one
  `blocked` event.
- A corpse in death-linger emits `corpseExplode` and never deals or takes
  "real" damage.

Use `createTestWorld({ seed: 42 })` from `tests/helpers/world-factory.ts`; never
construct a world manually. Add property-based coverage in `tests/property/` for
the non-negative-HP and overkill-clamp invariants.

## Constitutional Compliance

- **Deterministic ECS:** all randomness via `world.rng`; pure roll helpers; no
  `Date.now()` (`world.elapsedMs` is passed in). ✅
- **Layer purity:** combat lives in `src/core/`, imports no Phaser; the renderer
  only consumes `CombatEvent`s. ✅
- **Lab-gated:** combat behavior is exercisable in the relevant `src/labs/`
  sandboxes alongside its ECS unit/integration tests. ✅
- **Single source of truth:** stat values/clamps are owned by `src/shared/stats.ts`
  and surfaced through `effective-stats.ts`; this spec does not restate them.
