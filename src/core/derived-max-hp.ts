import { hasComponent } from 'bitecs';
import { Health } from './components.js';
import type { GameWorld } from './world.js';

/**
 * Apply the derived-max-HP delta onto Health.max/current for entities that have
 * Health. Uses additive delta (not absolute overwrite) so non-derived bonuses in
 * `health.max` are preserved.
 */
export function syncHealthFromDerivedMaxHpDelta(
  world: GameWorld,
  entity: number,
  prevDerivedMaxHp: number,
): void {
  if (!hasComponent(world.ecs, entity, Health)) {
    return;
  }

  const newDerivedMaxHp = world.stores.effectiveStats.maxHp[entity] ?? 0;
  const delta = newDerivedMaxHp - prevDerivedMaxHp;
  if (delta === 0) {
    return;
  }

  const currentMax = world.stores.health.max[entity] ?? 0;
  const nextMax = Math.max(1, currentMax + delta);
  world.stores.health.max[entity] = nextMax;
  const currentHp = world.stores.health.current[entity] ?? 0;
  if (delta > 0) {
    world.stores.health.current[entity] = currentHp + delta;
  } else {
    world.stores.health.current[entity] = Math.min(currentHp, nextMax);
  }
}
