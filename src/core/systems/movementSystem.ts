import { query } from 'bitecs';
import { Position, Velocity } from '../components.js';
import type { GameWorld } from '../world.js';

export function movementSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Position, Velocity]);
  const { position, velocity } = world.stores;

  for (const eid of entities) {
    if (eid === undefined) {
      continue;
    }

    position.x[eid] = (position.x[eid] ?? 0) + (velocity.x[eid] ?? 0);
    position.y[eid] = (position.y[eid] ?? 0) + (velocity.y[eid] ?? 0);
  }
}
