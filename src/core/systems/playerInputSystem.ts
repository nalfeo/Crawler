import { hasComponent, query, setComponent } from 'bitecs';
import { PLAYER_SPEED } from '../../shared/constants.js';
import { normalizeInputDirection, type InputState } from '../../shared/input.js';
import { Player, Stats, Velocity } from '../components.js';
import type { GameWorld } from '../world.js';

export function playerInputSystem(world: GameWorld, input: InputState): void {
  const playerEntities = query(world.ecs, [Player, Velocity]);
  const { moveX, moveY } = normalizeInputDirection(input.moveX, input.moveY);

  for (const eid of playerEntities) {
    if (eid === undefined) {
      continue;
    }

    // Use stats.moveSpeed if the Stats component is present; otherwise fall back to constant
    const moveSpeed = hasComponent(world.ecs, eid, Stats)
      ? (world.stores.stats.moveSpeed[eid] ?? PLAYER_SPEED)
      : PLAYER_SPEED;

    setComponent(world.ecs, eid, Velocity, { x: moveX * moveSpeed, y: moveY * moveSpeed });
  }
}
