import { hasComponent, query, removeEntity } from 'bitecs';
import { Health, Player } from '../components.js';
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
      if (hasComponent(world.ecs, eid, Player)) {
        world.state = 'game_over';
      } else {
        removeEntity(world.ecs, eid);
      }
    }
  }
}
