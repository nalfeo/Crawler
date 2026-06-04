import { query, removeComponent } from 'bitecs';
import { Knockback, Position } from '../components.js';
import type { GameWorld } from '../world.js';

/**
 * Knockback system — smoothly displaces entities each frame.
 *
 * Each frame, moves the entity by (dirX * speed, dirY * speed) and
 * decrements `remaining` by `speed`. When remaining <= 0, the
 * Knockback component is removed.
 */
export function knockbackSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Knockback, Position]);
  const { position, knockback } = world.stores;

  for (const eid of entities) {
    if (eid === undefined) continue;

    const remaining = knockback.remaining[eid] ?? 0;
    const speed = knockback.speed[eid] ?? 0;

    if (remaining <= 0 || speed <= 0) {
      removeComponent(world.ecs, eid, Knockback);
      continue;
    }

    const step = Math.min(speed, remaining);
    const dirX = knockback.dirX[eid] ?? 0;
    const dirY = knockback.dirY[eid] ?? 0;

    position.x[eid] = (position.x[eid] ?? 0) + dirX * step;
    position.y[eid] = (position.y[eid] ?? 0) + dirY * step;

    knockback.remaining[eid] = remaining - step;

    if (remaining - step <= 0) {
      removeComponent(world.ecs, eid, Knockback);
    }
  }
}
