import { hasComponent, query, removeEntity } from 'bitecs';
import { Bouncing, Position, Projectile, Returning, Velocity } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import { pruneAttackEntity } from '../weapon-telemetry.js';
import type { GameWorld } from '../world.js';
import { ARENA } from '../../shared/constants.js';

/** Margin beyond play-area bounds before culling (12.5 feet). */
const CULL_MARGIN = 12.5;

const PLAY_BOUNDS = {
  minX: 0,
  maxX: ARENA.WIDTH_FT,
  minY: 0,
  maxY: ARENA.HEIGHT_FT,
};

function getPlayBounds(world: GameWorld): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const floorMap = world.floorMap;
  if (floorMap) {
    return {
      minX: 0,
      maxX: floorMap.widthFt,
      minY: 0,
      maxY: floorMap.heightFt,
    };
  }
  return PLAY_BOUNDS;
}

/**
 * Removes projectiles that have hit a wall or left the game bounds.
 *
 * Bouncing projectiles (with the Bouncing component) reflect off the inner
 * play bounds and decrement their remaining-bounce counter until exhausted.
 *
 * Returning projectiles (with the Returning component) do NOT despawn on reaching
 * max range — they should only despawn if the owner is dead/unreachable or if
 * they hit an obstacle while returning.
 *
 * Non-returning projectiles despawn when they exceed their maxRange (distance from spawn).
 *
 * Wall-hit detection: the movementSystem uses slide-based collision and
 * prevents projectiles from entering impassable tiles.  This means a
 * projectile's *current* position is always passable — we must check the
 * *intended* next position (pos + vel).  If that position is impassable the
 * projectile is blocked and should be despawned.
 */
export function projectileCleanupSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Projectile, Position]);
  const { position, velocity, projectile } = world.stores;
  const floorMap = world.floorMap;
  const playBounds = getPlayBounds(world);
  const cullBounds = {
    minX: playBounds.minX - CULL_MARGIN,
    maxX: playBounds.maxX + CULL_MARGIN,
    minY: playBounds.minY - CULL_MARGIN,
    maxY: playBounds.maxY + CULL_MARGIN,
  };

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const isBeyondPlayBounds =
      x < playBounds.minX || x > playBounds.maxX || y < playBounds.minY || y > playBounds.maxY;

    if (
      isBeyondPlayBounds &&
      hasComponent(world.ecs, eid, Bouncing) &&
      hasComponent(world.ecs, eid, Velocity)
    ) {
      const remaining = world.stores.bouncing.remainingBounces[eid] ?? 0;
      if (remaining > 0) {
        let bounced = false;
        if (x < playBounds.minX || x > playBounds.maxX) {
          world.stores.velocity.x[eid] = -(world.stores.velocity.x[eid] ?? 0);
          position.x[eid] = Math.max(playBounds.minX, Math.min(playBounds.maxX, x));
          bounced = true;
        }
        if (y < playBounds.minY || y > playBounds.maxY) {
          world.stores.velocity.y[eid] = -(world.stores.velocity.y[eid] ?? 0);
          position.y[eid] = Math.max(playBounds.minY, Math.min(playBounds.maxY, y));
          bounced = true;
        }
        if (bounced) {
          // Corner impacts invert both axes but still count as one wall-bounce event.
          world.stores.bouncing.remainingBounces[eid] = remaining - 1;
          continue;
        }
      } else {
        clearEntityStores(world, eid);
        pruneAttackEntity(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }
    }

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
        pruneAttackEntity(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }
    }

    // Max range check for non-returning projectiles
    const isReturning = hasComponent(world.ecs, eid, Returning);
    if (!isReturning) {
      const maxRange = projectile.maxRange[eid] ?? 0;
      if (maxRange > 0) {
        const originX = projectile.originX[eid] ?? 0;
        const originY = projectile.originY[eid] ?? 0;
        const dx = x - originX;
        const dy = y - originY;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxRange * maxRange) {
          clearEntityStores(world, eid);
          pruneAttackEntity(world, eid);
          removeEntity(world.ecs, eid);
          continue;
        }
      }
    }

    if (x < cullBounds.minX || x > cullBounds.maxX || y < cullBounds.minY || y > cullBounds.maxY) {
      clearEntityStores(world, eid);
      pruneAttackEntity(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
