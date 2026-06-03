import { query, removeEntity } from 'bitecs';
import { Position, Projectile } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';

/** Margin beyond screen bounds before culling. */
const CULL_MARGIN = 100;

const BOUNDS = {
  minX: -CULL_MARGIN,
  maxX: GAME.WIDTH + CULL_MARGIN,
  minY: -CULL_MARGIN,
  maxY: GAME.HEIGHT + CULL_MARGIN,
};

/** Removes projectiles that have left the game bounds. */
export function projectileCleanupSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Projectile, Position]);
  const { position } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;

    if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) {
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
