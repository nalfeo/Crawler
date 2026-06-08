import type { CatalogEffect } from '../../shared/progression-effects.js';
import type { StatModifier } from '../../shared/skills.js';
import type { GameWorld } from '../../core/world.js';
import { addStatModifier } from './statsSystem.js';

interface ApplyCatalogEffectOptions {
  sourceType: StatModifier['sourceType'];
  sourceId: string;
  effect: CatalogEffect;
  expiresFrame?: number;
}

export function applyCatalogEffect(world: GameWorld, options: ApplyCatalogEffectOptions): void {
  const { sourceType, sourceId, effect, expiresFrame } = options;

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
      addStatModifier(world, {
        sourceType,
        sourceId,
        stat: 'damage',
        op: 'add',
        value: 0,
        expiresFrame,
      });
      break;
  }
}
