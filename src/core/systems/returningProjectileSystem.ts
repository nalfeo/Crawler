import { entityExists, hasComponent, query, removeEntity, setComponent } from 'bitecs';
import { Owner, Position, Returning, Velocity } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';

const PICKUP_RADIUS_SQ = 16 * 16;

/** Handles returning projectile logic (boomerangs, etc.). */
export function returningProjectileSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Returning, Position, Velocity]);
  const { position, returning, owner } = world.stores;

  for (const eid of entities) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const isReturning = (returning.isReturning[eid] ?? 0) !== 0;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (owner.eid[eid] ?? 0) : -1;

    if (!isReturning) {
      // Check if projectile has exceeded max range
      const originX = returning.originX[eid] ?? 0;
      const originY = returning.originY[eid] ?? 0;
      const x = position.x[eid] ?? 0;
      const y = position.y[eid] ?? 0;
      const dx = x - originX;
      const dy = y - originY;
      const distSq = dx * dx + dy * dy;
      const maxRange = returning.maxRange[eid] ?? 0;

      if (distSq >= maxRange * maxRange) {
        // Start returning
        returning.isReturning[eid] = 1;
      }
    }

    if ((returning.isReturning[eid] ?? 0) !== 0) {
      // Owner dead/missing? Despawn.
      if (ownerEid < 0 || !entityExists(world.ecs, ownerEid) || !hasComponent(world.ecs, ownerEid, Position)) {
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
        continue;
      }

      const x = position.x[eid] ?? 0;
      const y = position.y[eid] ?? 0;
      const ownerX = position.x[ownerEid] ?? 0;
      const ownerY = position.y[ownerEid] ?? 0;
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
      const returnSpeed = returning.returnSpeed[eid] ?? 0;
      const vx = (dx / dist) * returnSpeed;
      const vy = (dy / dist) * returnSpeed;

      setComponent(world.ecs, eid, Velocity, { x: vx, y: vy });
    }
  }
}
