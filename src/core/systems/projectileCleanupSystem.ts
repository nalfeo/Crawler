import { query, removeEntity } from 'bitecs';
import { Position, Projectile } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { GAME } from '../../shared/constants.js';
import { ftToPx } from '../../shared/units.js';

/** Margin beyond screen bounds before culling (12.5 feet). */
const CULL_MARGIN = ftToPx(12.5);

const BOUNDS = {
  minX: -CULL_MARGIN,
  maxX: GAME.WIDTH + CULL_MARGIN,
  minY: -CULL_MARGIN,
  maxY: GAME.HEIGHT + CULL_MARGIN,
};

/**
 * Removes projectiles that have hit a wall or left the game bounds.
 *
 * Wall-hit detection: the movementSystem uses slide-based collision and
 * prevents projectiles from entering impassable tiles.  This means a
 * projectile's *current* position is always passable — we must check the
 * *intended* next position (pos + vel).  If that position is impassable the
 * projectile is blocked and should be despawned.
 */
export function projectileCleanupSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Projectile, Position]);
  const { position, velocity } = world.stores;
  const floorMap = world.floorMap;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;

    // Wall-hit: if the next-frame position is impassable the projectile would
    // be stuck by the movement system — despawn it now instead of leaving it
    // frozen at the wall edge.  Projectiles don't slide; if the straight-line
    // destination is blocked, they despawn immediately.
    if (floorMap) {
      const vx = velocity.x[eid] ?? 0;
      const vy = velocity.y[eid] ?? 0;
      const nextX = x + vx;
      const nextY = y + vy;
      if (!floorMap.isPassableAt(nextX, nextY)) {
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }
    }

    if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) {
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
