import { hasComponent, query } from 'bitecs';
import { Flying, Position, Velocity } from '../components.js';
import type { GameWorld } from '../world.js';

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

    const isFlying = hasComponent(world.ecs, eid, Flying);
    if (floorMap) {
      if (isFlying) {
        if (newX < 0 || newX >= floorMap.widthPx || newY < 0 || newY >= floorMap.heightPx) {
          continue;
        }
        position.x[eid] = newX;
        position.y[eid] = newY;
        continue;
      }

      // Slide-based collision: try full move, then each axis independently
      if (floorMap.isPassableAt(newX, newY)) {
        position.x[eid] = newX;
        position.y[eid] = newY;
      } else if (floorMap.isPassableAt(newX, oldY)) {
        position.x[eid] = newX;
      } else if (floorMap.isPassableAt(oldX, newY)) {
        position.y[eid] = newY;
      }
      // else: stuck — don't move
    } else {
      // No map loaded — unrestricted movement (legacy behavior)
      position.x[eid] = newX;
      position.y[eid] = newY;
    }
  }
}
