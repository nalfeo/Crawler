import { hasComponent, query, removeEntity } from 'bitecs';
import { Enemy, Health, Player } from '../components.js';
import { clearEntityStores, spawnXpGem } from '../helpers.js';
import type { GameWorld } from '../world.js';

export function healthSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Health]);
  const { health, position } = world.stores;

  for (const eid of Array.from(entities)) {
    if (eid === undefined) {
      continue;
    }

    const currentHealth = health.current[eid] ?? 0;

    if (currentHealth <= 0) {
      if (hasComponent(world.ecs, eid, Player)) {
        world.state = 'game_over';
      } else {
        // Drop XP gem at enemy's death position
        if (hasComponent(world.ecs, eid, Enemy)) {
          const x = position.x[eid] ?? 0;
          const y = position.y[eid] ?? 0;
          spawnXpGem(world, x, y, 1);
        }

        clearEntityStores(world, eid);
        removeEntity(world.ecs, eid);
      }
    }
  }
}
