import { hasComponent, query } from 'bitecs';
import { Player, Enemy, Invincible, EffectiveStats, DeathTimer, BloodColor } from './components.js';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from './world.js';
import { resolveCrit, resolveDodge } from './combat-rolls.js';

/** Fallback blood colour (red) when an enemy carries no BloodColor component. */
const DEFAULT_BLOOD_COLOR = 0xcc0000;

/**
 * Emit a `corpseExplode` combat event for a corpse struck during its
 * death-linger window. Render-only: the engine cuts the corpse sprite into
 * shards that spray along the blow's direction. Reads the dying enemy's blood
 * colour and sprite variant so the shards match the body that just burst.
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
 *   - Dodge: a player target can fully avoid an incoming hit (player-only).
 *   - Crit: player-sourced damage to an enemy can critically strike, scaling
 *     the amount by the player's critMultiplier.
 * The target's type fixes the direction of damage — an enemy target means the
 * blow is player-sourced (crit), a player target means it is enemy-sourced
 * (dodge) — so neither path needs the attacker entity.
 */
export function applyDamage(
  world: GameWorld,
  target: number,
  amount: number,
  x: number,
  y: number,
  weaponGoreFactor?: number,
  sourceX?: number,
  sourceY?: number,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (hasComponent(world.ecs, target, Invincible)) return 0;

  // Corpse drama: a dead enemy still in its death-linger window bursts into
  // sprite shards when hit by any player attack rather than soaking the blow.
  // All offensive damage (projectile / melee / AoE / beam) funnels through here,
  // so this single guard covers every weapon. The corpse is already at 0 HP, so
  // we emit the VFX event once (guarded on a still-running timer) and zero the
  // death timer — deathTimerSystem reaps the entity later this same frame.
  if (hasComponent(world.ecs, target, Enemy) && hasComponent(world.ecs, target, DeathTimer)) {
    const remainingMs = world.stores.deathTimer.remainingMs[target] ?? 0;
    if (remainingMs > 0) {
      emitCorpseExplosion(world, target, x, y, amount, sourceX, sourceY);
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

  // Crit: player-sourced damage to an enemy. Reads the player singleton's
  // Luck-derived critChance / critMultiplier from EffectiveStats.
  let finalAmount = amount;
  let isCrit = false;
  if (!isPlayerTarget && hasComponent(world.ecs, target, Enemy)) {
    const player = query(world.ecs, [Player, EffectiveStats])[0];
    if (player !== undefined) {
      const critChance = world.stores.effectiveStats.critChance[player] ?? 0;
      const critMultiplier = world.stores.effectiveStats.critMultiplier[player] ?? 1;
      const result = resolveCrit(world.rng.next(), amount, critChance, critMultiplier);
      finalAmount = result.amount;
      isCrit = result.isCrit;
    }
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
      weaponGoreFactor,
      sourceX,
      sourceY,
    };
    if (isCrit) event.isCrit = true;
    world.combatEvents.push(event);
  }

  return dealt;
}
