import { hasComponent, query, removeEntity } from 'bitecs';
import { AoeOnImpact, EnemyProjectile, Position, Projectile, Returning, Velocity } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';
import { clearProjectilePierceHits } from './damageSystem.js';
import { WeaponType } from '../../shared/constants.js';
import type { CombatWeaponType } from '../../shared/combat-events.js';

export function movementSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Position, Velocity]);
  const { position, velocity } = world.stores;
  const floorMap = world.floorMap;

  for (const eid of entities) {
    if (eid === undefined) {
      continue;
    }

    const oldX = position.x[eid] ?? 0;
    const oldY = position.y[eid] ?? 0;
    const newX = oldX + (velocity.x[eid] ?? 0);
    const newY = oldY + (velocity.y[eid] ?? 0);

    if (floorMap) {
      // Slide-based collision: try full move, then each axis independently
      const passFull = floorMap.isPassableAt(newX, newY);
      const passX = floorMap.isPassableAt(newX, oldY);
      const passY = floorMap.isPassableAt(oldX, newY);

      if (passFull) {
        position.x[eid] = newX;
        position.y[eid] = newY;
      } else if (passX) {
        position.x[eid] = newX;
      } else if (passY) {
        position.y[eid] = newY;
      } else if (hasComponent(world.ecs, eid, Projectile)) {
        world.combatEvents.push({
          type: 'surface-hit',
          x: oldX,
          y: oldY,
          amount: 0,
          timestamp: world.elapsedMs,
          targetEid: eid,
          surfaceType: 'wall',
          weaponType: resolveProjectileWeaponType(world, eid),
          sourceX: oldX - (velocity.x[eid] ?? 0),
          sourceY: oldY - (velocity.y[eid] ?? 0),
        });
        clearProjectilePierceHits(world, eid);
        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
      }
      // else: stuck — don't move
    } else {
      // No map loaded — unrestricted movement (legacy behavior)
      position.x[eid] = newX;
      position.y[eid] = newY;
    }
  }

  function resolveProjectileWeaponType(world: GameWorld, eid: number): CombatWeaponType {
    if (hasComponent(world.ecs, eid, EnemyProjectile)) return 'enemy-projectile';
    if (hasComponent(world.ecs, eid, AoeOnImpact)) return WeaponType.MAGIC;
    if (hasComponent(world.ecs, eid, Returning)) return WeaponType.THROWN;
    return WeaponType.RANGED;
  }
}
