import { entityExists, hasComponent, query, removeEntity, setComponent } from 'bitecs';
import { Owner, Position, Projectile, Returning, Velocity } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import { clearProjectilePierceHits } from './damageSystem.js';
import type { GameWorld } from '../world.js';

const PICKUP_RADIUS_SQ = 16 * 16;

/** Handles returning projectile logic (boomerangs, etc.). */
export function returningProjectileSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Returning, Position, Velocity]);
  const { position, returning, owner } = world.stores;

  for (const eid of entities) {
    if (!entityExists(world.ecs, eid)) {
      continue;
    }

    const isReturning = returning.isReturning[eid] !== 0;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? owner.eid[eid]! : -1;

    if (!isReturning) {
      // Check if projectile has exceeded max range
      const originX = returning.originX[eid]!;
      const originY = returning.originY[eid]!;
      const x = position.x[eid]!;
      const y = position.y[eid]!;
      const dx = x - originX;
      const dy = y - originY;
      const distSq = dx * dx + dy * dy;
      const maxRange = returning.maxRange[eid]!;

      if (distSq >= maxRange * maxRange) {
        // Start returning with infinite pierce on inbound leg
        returning.isReturning[eid] = 1;
        if (hasComponent(world.ecs, eid, Projectile)) {
          world.stores.projectile.pierce[eid] = 255;
          world.stores.projectile.hitCount[eid] = 0;
          clearProjectilePierceHits(world, eid);
        }
      }
    }

    if (returning.isReturning[eid] !== 0) {
      // Owner dead/missing? Despawn.
      if (
        ownerEid < 0 ||
        !entityExists(world.ecs, ownerEid) ||
        !hasComponent(world.ecs, ownerEid, Position)
      ) {
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }

      const x = position.x[eid]!;
      const y = position.y[eid]!;
      const ownerX = position.x[ownerEid]!;
      const ownerY = position.y[ownerEid]!;
      const dx = ownerX - x;
      const dy = ownerY - y;
      const distSq = dx * dx + dy * dy;

      // Arrived back at owner
      if (distSq <= PICKUP_RADIUS_SQ) {
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }

      // Steer towards owner
      const dist = Math.sqrt(distSq);
      const returnSpeed = returning.returnSpeed[eid]!;
      const vx = (dx / dist) * returnSpeed;
      const vy = (dy / dist) * returnSpeed;

      setComponent(world.ecs, eid, Velocity, { x: vx, y: vy });
    }
  }
}
