import { hasComponent, query, removeEntity } from 'bitecs';
import { DeathTimer, Enemy, Health, Player } from '../components.js';
import { clearEntityStores } from '../helpers.js';
import type { GameWorld } from '../world.js';

export function healthSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Health]);
  const { health } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const currentHealth = health.current[eid] ?? 0;

    if (currentHealth <= 0) {
      // Skip entities with DeathTimer — they're handled by deathTimerSystem
      if (hasComponent(world.ecs, eid, DeathTimer)) {
        continue;
      }

      if (hasComponent(world.ecs, eid, Player)) {
        world.state = 'game_over';
      } else {
        // Drops are handled by dropSystem which runs before healthSystem.
        // We only handle entity cleanup here.
        if (hasComponent(world.ecs, eid, Enemy)) {
          // no-op: drops already spawned by dropSystem
        }

        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
      }
    }
  }
}
