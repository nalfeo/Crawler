import { hasComponent, query } from 'bitecs';
import {
  Player,
  Enemy,
  Invincible,
  EffectiveStats,
  DeathTimer,
  BloodColor,
  Spawner,
  Companion,
} from './components.js';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from './world.js';
import { resolveCrit, resolveDodge } from './combat-rolls.js';
import { DEFAULT_BLOOD_COLOR } from '../shared/constants.js';
import { getBodyHalfWidth } from './physics-body.js';
import type { DamageAffinity } from '../shared/stats.js';
import { computePlayerScaledDamage } from './combat-math.js';
import { FAIL_CLOSED_DAMAGE_META, type DamageOrigin } from './damage-meta.js';
import { affinityMultiplier, type Affinity } from '../shared/data/floor3/affinity.js';

/**
 * Fail-closed metadata describing WHO dealt this damage and how it should
 * scale/crit. Every damage-bearing/delayed entity path persists this via
 * `core/damage-meta.ts` and reads it back here; instant resolutions (spell
 * casts, corpse-step) pass it inline. Fresh/unset fields never scale or crit
 * — see `FAIL_CLOSED_DAMAGE_META`.
 */
export interface DamageOptions {
  /** Who dealt this damage. Numeric zero decodes to `'environment'` (fail-closed). */
  readonly origin: DamageOrigin;
  /** Damage type for the typed-primary multiplier (STR physical / INT magic). */
  readonly affinity: DamageAffinity;
  /**
   * Whether the typed-primary multiplier (STR for physical, INT for magic)
   * applies. `false` for magic-spell damage that already resolved its own
   * INT scaling via `resolveScalableOutput` (avoids double-scaling).
   */
  readonly scaleWithPrimary: boolean;
  /** Whether this hit is eligible to roll a critical strike. */
  readonly canCrit: boolean;
  /** Gore/VFX intensity hint (0..1). */
  readonly weaponGoreFactor?: number;
  readonly sourceX?: number;
  readonly sourceY?: number;
  readonly sourceEid?: number;
  /**
   * Stable archetype identity of the attacker, pre-snapshotted before any
   * entity removal/EID-recycling can invalidate a live EID lookup. When
   * provided, `applyDamage` propagates this directly into the emitted
   * `CombatEvent.sourceArchetypeKey` without any further EID resolution.
   * Preferred over deriving the key from `sourceEid` at impact time.
   */
  readonly sourceArchetypeKey?: string;
  /** Render-only classification of the successful hit's delivery path. */
  readonly delivery?: CombatEvent['delivery'];
  /**
   * True when this damage was dealt by a player active ability (spell, etc.).
   * Propagated to the emitted `CombatEvent.fromActiveAbility` flag so in-run
   * harnesses can attribute ability DPS without a second RNG-divergent run.
   */
  readonly fromActiveAbility?: boolean;
  /**
   * Floor 3 Companion League Temperament (affinity) hook — ADR 0071 D3,
   * spec `floor3-companion-league.md` R3. Named distinctly from the
   * `affinity: DamageAffinity` field above (an unrelated STR/INT
   * typed-primary concept) to avoid confusion between the two.
   *
   * Both fields must be supplied together for the `AFFINITY_MATRIX`
   * multiplier to apply; a companion-vs-companion hit on Floor 3 supplies
   * both, every other floor/damage path omits both (fail-closed no-op).
   * Independent of `origin`/`scaleWithPrimary`/`canCrit` since Floor 3
   * combat is companion-sourced, not player-sourced (R1: the player and
   * handlers are invulnerable non-combatants).
   */
  readonly attackerTemperament?: Affinity;
  readonly defenderTemperament?: Affinity;
}

/** Convenience: the fail-closed default options (never scales, never crits, environment-sourced). */
export const DEFAULT_DAMAGE_OPTIONS: DamageOptions = FAIL_CLOSED_DAMAGE_META;

/**
 * Emit a `corpseExplode` combat event for a corpse struck during its
 * death-linger window. The event itself is consumed render-side (the engine
 * cuts the corpse sprite into shards that spray along the blow's direction) —
 * the *gameplay* state change (expiring the body early) lives in the caller,
 * which zeros the death timer. Reads the dying enemy's blood colour and sprite
 * variant so the shards match the body that just burst.
 */
function emitCorpseExplosion(
  world: GameWorld,
  target: number,
  x: number,
  y: number,
  amount: number,
  sourceX?: number,
  sourceY?: number,
): void {
  const bloodColor = hasComponent(world.ecs, target, BloodColor)
    ? ((world.stores.bloodColor.r[target] ?? 0) << 16) |
      ((world.stores.bloodColor.g[target] ?? 0) << 8) |
      (world.stores.bloodColor.b[target] ?? 0)
    : DEFAULT_BLOOD_COLOR;
  const spriteTextureId = world.stores.sprite.textureId[target] ?? 0;
  const spriteAppearanceKey = world.enemyAppearanceKeys.get(target);
  const spriteVariantRoll = world.stores.sprite.variantRoll[target] ?? 0;
  const spriteSizeScale = world.stores.sprite.sizeScale[target] || 1;
  const spriteWidth = getBodyHalfWidth(world, target, 'apply-damage') * 2;

  // Shards spray away from the attacker (the same way the force travelled).
  let dirX = 0;
  let dirY = 0;
  if (
    sourceX !== undefined &&
    sourceY !== undefined &&
    (Math.abs(x - sourceX) > 0.01 || Math.abs(y - sourceY) > 0.01)
  ) {
    const dx = x - sourceX;
    const dy = y - sourceY;
    const dist = Math.hypot(dx, dy);
    dirX = dx / dist;
    dirY = dy / dist;
  }

  world.combatEvents.push({
    type: 'corpseExplode',
    x,
    y,
    amount,
    targetType: 'enemy',
    timestamp: world.elapsedMs,
    targetEid: target,
    bloodColor,
    spriteTextureId,
    spriteAppearanceKey,
    spriteVariantRoll,
    spriteSizeScale,
    spriteWidth,
    knockbackDirX: dirX,
    knockbackDirY: dirY,
    sourceX,
    sourceY,
  });
}

/**
 * Single choke point for all damage application.
 * Reduces target HP and emits a CombatEvent for VFX.
 * Returns the actual damage dealt (clamped to remaining HP).
 * Skips the event when actual damage is zero (e.g. 0-damage sources).
 *
 * Secondary stats hook in here, gated on the relevant entity having
 * `EffectiveStats` so bare test worlds (no stat stores) keep deterministic,
 * roll-free behavior:
 *   - Dodge: a player target can fully avoid an incoming hit (player-only,
 *     independent of `options` — enemies/environment are the only possible
 *     sources of player-target damage).
 *   - Player-sourced offense: ONLY `options.origin === 'player'` damage to an
 *     Enemy target applies the generic offense
 *     `(base + damageBonus) * (1 + damagePercent)`, then — when
 *     `scaleWithPrimary` — the typed-primary multiplier (STR for physical
 *     affinity, INT for magic), then — when `canCrit` — a crit roll using
 *     critChance/critMultiplier. Enemy/environment-origin damage never scales.
 * The target's type fixes the direction of dodge — a player target means the
 * blow is enemy/environment-sourced — so dodge doesn't need `options.origin`.
 */
export function applyDamage(
  world: GameWorld,
  target: number,
  amount: number,
  x: number,
  y: number,
  options: DamageOptions,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (hasComponent(world.ecs, target, Invincible)) return 0;

  // Corpse drama: a dead enemy still in its death-linger window bursts into
  // sprite shards when hit by any player attack rather than soaking the blow.
  // All offensive damage (projectile / melee / AoE / beam) funnels through here,
  // so this single guard covers every weapon. Bursting is a REAL gameplay state
  // change — we zero the death timer so deathTimerSystem reaps the body early
  // this same frame (relevant to corpse-consuming systems such as necromancy),
  // not merely a render flourish.
  //
  // EXCEPTION — Spawner structures (rats-nest / slime-pit): a dying spawner
  // lingers as an Enemy+DeathTimer "corpse" only so its scripted death handshake
  // can finish. spawnerSystem fires the finale wave and sets `deathResolved` on
  // the tick AFTER the kill, then spawnerArenaSystem reads that flag to move a
  // LOCKED arena to RESOLVED (lowers the fence, unlocks doors, grants banked XP).
  // Reaping the spawner early destroys the entity before that multi-tick
  // handshake runs, permanently orphaning the locked arena and trapping the
  // player. A spawner is a structure, not a burstable fleshy corpse, so it must
  // never be step-burst or weapon-burst — skip it here (the choke point covering
  // every damage source) as well as in corpseStepSystem. Determinism-neutral:
  // the corpse branch already returns before any world.rng roll, so this early
  // return consumes no RNG.
  if (hasComponent(world.ecs, target, Enemy) && hasComponent(world.ecs, target, DeathTimer)) {
    if (hasComponent(world.ecs, target, Spawner)) return 0;
    const remainingMs = world.stores.deathTimer.remainingMs[target] ?? 0;
    if (remainingMs > 0) {
      emitCorpseExplosion(world, target, x, y, amount, options.sourceX, options.sourceY);
      world.stores.deathTimer.remainingMs[target] = 0;
    }
    return 0;
  }

  const isPlayerTarget = hasComponent(world.ecs, target, Player);

  // Dodge: player fully avoids an incoming hit. Player-only — enemies never
  // dodge. Negates the hit entirely and emits a 'dodge' event for VFX.
  if (isPlayerTarget && hasComponent(world.ecs, target, EffectiveStats)) {
    const dodgeChance = world.stores.effectiveStats.dodgeChance[target] ?? 0;
    if (resolveDodge(world.rng.next(), dodgeChance)) {
      world.combatEvents.push({
        type: 'dodge',
        x,
        y,
        amount: 0,
        targetType: 'player',
        timestamp: world.elapsedMs,
        targetEid: target,
      });
      return 0;
    }
  }

  // Player-sourced offense + crit: reads the player singleton's EffectiveStats
  // and applies flat/percent damage bonuses, the typed-primary multiplier, and
  // an optional crit roll — ONLY for player-origin damage to an Enemy target.
  let finalAmount = amount;
  let isCrit = false;
  if (options.origin === 'player' && !isPlayerTarget && hasComponent(world.ecs, target, Enemy)) {
    const player = query(world.ecs, [Player, EffectiveStats])[0];
    if (player !== undefined) {
      const scaledAmount = computePlayerScaledDamage(
        amount,
        {
          damageBonus: world.stores.effectiveStats.damageBonus[player] ?? 0,
          damagePercent: world.stores.effectiveStats.damagePercent[player] ?? 0,
          strength: world.stores.effectiveStats.strength[player] ?? 0,
          intelligence: world.stores.effectiveStats.intelligence[player] ?? 0,
        },
        options,
      );
      if (options.canCrit) {
        const critChance = world.stores.effectiveStats.critChance[player] ?? 0;
        const critMultiplier = world.stores.effectiveStats.critMultiplier[player] ?? 1;
        const result = resolveCrit(world.rng.next(), scaledAmount, critChance, critMultiplier);
        finalAmount = result.amount;
        isCrit = result.isCrit;
      } else {
        finalAmount = scaledAmount;
      }
    }
  }

  // Floor 3 Companion League Temperament multiplier: applies whenever both
  // sides of the hit supply a Temperament (companion-vs-companion combat).
  // Composes with any player-sourced scaling above rather than replacing it,
  // so this stays a total no-op on every non-Floor-3 damage path (neither
  // field set).
  if (options.attackerTemperament !== undefined && options.defenderTemperament !== undefined) {
    finalAmount *= affinityMultiplier(options.attackerTemperament, options.defenderTemperament);
  }

  const current = world.stores.health.current[target] ?? 0;
  const dealt = Math.min(current, finalAmount);
  world.stores.health.current[target] = current - dealt;

  if (dealt > 0) {
    const targetType: CombatEvent['targetType'] = isPlayerTarget ? 'player' : 'enemy';
    const event: CombatEvent = {
      type: 'hit',
      x,
      y,
      amount: dealt,
      targetType,
      timestamp: world.elapsedMs,
      targetEid: target,
      weaponGoreFactor: options.weaponGoreFactor,
      sourceX: options.sourceX,
      sourceY: options.sourceY,
    };
    if (isCrit) event.isCrit = true;
    if (options.sourceEid !== undefined) {
      event.sourceEid = options.sourceEid;
      event.sourceRenderGeneration = world.entityRenderGeneration[options.sourceEid];
      // Prefer a pre-snapshotted key (from options.sourceArchetypeKey, captured
      // at spawn time) over a live EID lookup. The live lookup is kept as the
      // fallback for melee/instant-damage sources where the attacker is guaranteed
      // live at hit time and no spawn-time snapshot is available.
      if (isPlayerTarget) {
        const sourceKey =
          options.sourceArchetypeKey ??
          world.enemyAppearanceKeys.get(options.sourceEid) ??
          world.floorScenario?.enemyArchetypes.get(options.sourceEid);
        if (sourceKey !== undefined) event.sourceArchetypeKey = sourceKey;
      }
    } else if (options.sourceArchetypeKey !== undefined && isPlayerTarget) {
      event.sourceArchetypeKey = options.sourceArchetypeKey;
    }
    event.targetRenderGeneration = world.entityRenderGeneration[target];
    if (options.delivery !== undefined) event.delivery = options.delivery;
    if (options.fromActiveAbility === true) event.fromActiveAbility = true;
    world.combatEvents.push(event);
    if (options.sourceEid !== undefined && current - dealt <= 0) {
      world.lethalDamageSourceByTarget.set(target, options.sourceEid);
    }

    // Floor 3 Companion League: attribute damage-weighted combat XP credit.
    // Only Companion-sourced hits on a non-player Enemy target count — player
    // weapon damage and environment damage never feed Companion XP (R7).
    if (
      dealt > 0 &&
      !isPlayerTarget &&
      hasComponent(world.ecs, target, Enemy) &&
      options.sourceEid !== undefined &&
      hasComponent(world.ecs, options.sourceEid, Companion)
    ) {
      let byCompanion = world.companionDamageContribution.get(target);
      if (byCompanion === undefined) {
        byCompanion = new Map();
        world.companionDamageContribution.set(target, byCompanion);
      }
      byCompanion.set(options.sourceEid, (byCompanion.get(options.sourceEid) ?? 0) + dealt);
    }

    // Floor 2 Slice 3 ally-defend: record who last hit the player into a
    // DURABLE per-world signal. The transient `combatEvents` queue above is
    // drained by the VFX layer every rendered frame, so a friendly-band mob's
    // retaliation prepass (familyFeudSystem) would never see this hit in the
    // real game if it scanned the queue. This field survives the drain.
    if (isPlayerTarget && options.sourceEid !== undefined && options.sourceEid >= 0) {
      world.lastPlayerHit = { attackerEid: options.sourceEid, atMs: world.elapsedMs };
    }
  }

  return dealt;
}
