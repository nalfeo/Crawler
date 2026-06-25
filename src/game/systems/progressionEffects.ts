import type { CatalogEffect } from '../../shared/progression-effects.js';
import type { StatModifier } from '../../shared/skills.js';
import type { GameWorld } from '../../core/world.js';
import { applyDamage } from '../../core/apply-damage.js';
import { addStatModifier } from './statsSystem.js';
import { addComponent, hasComponent, query } from 'bitecs';
import { Enemy, Health, Knockback, Position } from '../../core/components.js';

interface ApplyCatalogEffectOptions {
  sourceType: StatModifier['sourceType'];
  sourceId: string;
  effect: CatalogEffect;
  expiresFrame?: number;
  holderEid?: number;
}

const DEFAULT_TILE_SIZE_PX = 32;

function tilesToPixels(world: GameWorld, radiusTiles: number): number {
  const tileSizePx = world.floorMap?.config.tileSizePx ?? DEFAULT_TILE_SIZE_PX;
  return radiusTiles * tileSizePx;
}

function castFireball(
  world: GameWorld,
  casterEid: number,
  damagePercent: number,
  radiusTiles: number,
): void {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const radiusPx = tilesToPixels(world, radiusTiles);
  const radiusSq = radiusPx * radiusPx;
  const baseDamage = world.stores.stats.damage[casterEid] ?? 10;
  const damage = Math.round(baseDamage * damagePercent);

  const enemies = [...query(world.ecs, [Enemy, Position, Health])].filter(
    (eid) => (world.stores.health.current[eid] ?? 0) > 0,
  );
  if (enemies.length === 0) return;

  // Pick the blast epicentre. Any living enemy within blast reach of the caster
  // is a candidate; prefer the one whose explosion catches the most enemies so
  // clusters are prioritised, and break ties by proximity to the caster so a
  // lone enemy still gets hit. This lets the fireball fire at any single enemy
  // without waiting for a group, while still favouring groups when they exist.
  let centerX = casterX;
  let centerY = casterY;
  let bestHits = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let hasTarget = false;

  for (const candidate of enemies) {
    const cx = world.stores.position.x[candidate] ?? 0;
    const cy = world.stores.position.y[candidate] ?? 0;
    const toCasterDx = cx - casterX;
    const toCasterDy = cy - casterY;
    const candidateDistSq = toCasterDx * toCasterDx + toCasterDy * toCasterDy;
    if (candidateDistSq > radiusSq) continue;

    let hits = 0;
    for (const other of enemies) {
      const ox = world.stores.position.x[other] ?? 0;
      const oy = world.stores.position.y[other] ?? 0;
      const dx = ox - cx;
      const dy = oy - cy;
      if (dx * dx + dy * dy <= radiusSq) hits += 1;
    }

    if (hits > bestHits || (hits === bestHits && candidateDistSq < bestDistSq)) {
      bestHits = hits;
      bestDistSq = candidateDistSq;
      centerX = cx;
      centerY = cy;
      hasTarget = true;
    }
  }

  if (!hasTarget) return;

  for (const enemyEid of enemies) {
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - centerX;
    const dy = ey - centerY;
    if (dx * dx + dy * dy <= radiusSq) {
      applyDamage(world, enemyEid, damage, ex, ey, undefined, centerX, centerY);
    }
  }
}

function castHeal(world: GameWorld, casterEid: number, baseHeal: number): void {
  const current = world.stores.health.current[casterEid] ?? 0;
  const max = world.stores.health.max[casterEid] ?? 100;
  const healable = Math.min(baseHeal, max - current);
  if (healable > 0) {
    world.stores.health.current[casterEid] = current + healable;
  }
}

function castPulseShield(
  world: GameWorld,
  casterEid: number,
  knockbackForce: number,
  radiusTiles: number,
): void {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const radiusPx = tilesToPixels(world, radiusTiles);
  const radiusSq = radiusPx * radiusPx;

  const enemies = [...query(world.ecs, [Enemy, Position, Health])];
  for (const enemyEid of enemies) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= radiusSq && distSq > 0) {
      const dist = Math.sqrt(distSq);
      if (!hasComponent(world.ecs, enemyEid, Knockback)) {
        addComponent(world.ecs, enemyEid, Knockback);
      }
      world.stores.knockback.dirX[enemyEid] = dx / dist;
      world.stores.knockback.dirY[enemyEid] = dy / dist;
      world.stores.knockback.remaining[enemyEid] = knockbackForce;
      world.stores.knockback.speed[enemyEid] = knockbackForce;
    }
  }
}

export function applyCatalogEffect(world: GameWorld, options: ApplyCatalogEffectOptions): void {
  const { sourceType, sourceId, effect, expiresFrame, holderEid } = options;

  switch (effect.type) {
    case 'stat_add':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: effect.stat,
        op: 'add',
        value: effect.value,
        expiresFrame,
      });
      break;

    case 'stat_multiply':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: effect.stat,
        op: 'multiply',
        value: effect.value,
        expiresFrame,
      });
      break;

    case 'extra_projectile':
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: 'projectileCount',
        op: 'add',
        value: effect.count,
        expiresFrame,
      });
      break;

    case 'aura':
      // TODO: Aura effects carry radius/dpsPercentOfDamage but are not yet implemented.
      // This no-op modifier registers the source so the aura system (future) can query active auras.
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: 'damage',
        op: 'add',
        value: 0,
        expiresFrame,
      });
      break;

    case 'spell_fireball':
      if (holderEid !== undefined) {
        castFireball(world, holderEid, effect.damagePercent, effect.radiusTiles);
      }
      break;

    case 'spell_heal':
      if (holderEid !== undefined) {
        castHeal(world, holderEid, effect.baseHeal);
      }
      break;

    case 'spell_pulse_shield':
      if (holderEid !== undefined) {
        castPulseShield(world, holderEid, effect.knockbackForce, effect.radiusTiles);
      }
      break;
  }
}
