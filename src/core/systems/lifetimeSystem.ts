import { entityExists, query, removeEntity } from 'bitecs';
import { Lifetime } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import { clearAreaDamageHits } from './areaDamageSystem.js';
import { clearProjectilePierceHits } from './damageSystem.js';
import { clearMeleeSwingHits } from './meleeSwingSystem.js';
import type { GameWorld } from '../world.js';

/** Removes entities whose Lifetime.expiresAtMs has passed. */
export function lifetimeSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Lifetime]);

  for (const eid of entities) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const expiresAt = world.stores.lifetime.expiresAtMs[eid] ?? 0;

    if (world.elapsedMs >= expiresAt) {
      clearAreaDamageHits(world, eid);
      clearMeleeSwingHits(world, eid);
      clearProjectilePierceHits(world, eid);
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
