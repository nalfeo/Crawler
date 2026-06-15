import type { CatalogEffect } from '../../shared/progression-effects.js';
import type { StatModifier } from '../../shared/skills.js';
import type { GameWorld } from '../../core/world.js';
import { applyDamage } from '../../core/apply-damage.js';
import { addStatModifier } from './statsSystem.js';
import { query } from 'bitecs';
import { Enemy, Position, Health } from '../../core/components.js';

interface ApplyCatalogEffectOptions {
  sourceType: StatModifier['sourceType'];
  sourceId: string;
  effect: CatalogEffect;
  expiresFrame?: number;
  holderEid?: number;
}

function castFireball(
  world: GameWorld,
  casterEid: number,
  damagePercent: number,
  radiusTiles: number,
): void {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const radiusPx = radiusTiles * 16;
  const radiusSq = radiusPx * radiusPx;
  const baseDamage = world.stores.stats.damage[casterEid] ?? 10;
  const damage = Math.round(baseDamage * damagePercent);

  const enemies = [...query(world.ecs, [Enemy, Position, Health])];
  for (const enemyEid of enemies) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    if (dx * dx + dy * dy <= radiusSq) {
      applyDamage(world, enemyEid, damage, ex, ey, undefined, casterX, casterY);
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
  const radiusPx = radiusTiles * 16;
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
      const pushX = (dx / dist) * knockbackForce;
      const pushY = (dy / dist) * knockbackForce;
      world.stores.position.x[enemyEid] = (world.stores.position.x[enemyEid] ?? 0) + pushX;
      world.stores.position.y[enemyEid] = (world.stores.position.y[enemyEid] ?? 0) + pushY;
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
