import { query, setComponent } from 'bitecs';
import { PLAYER_SPEED } from '../../shared/constants.js';
import { normalizeInputDirection, type InputState } from '../../shared/input.js';
import { Player, Velocity } from '../components.js';
import type { GameWorld } from '../world.js';

export function playerInputSystem(world: GameWorld, input: InputState): void {
  const playerEntities = query(world.ecs, [Player, Velocity]);
  const { moveX, moveY } = normalizeInputDirection(input.moveX, input.moveY);
  const velocityX = moveX * PLAYER_SPEED;
  const velocityY = moveY * PLAYER_SPEED;

  for (const eid of playerEntities) {
    if (eid === undefined) {
      continue;
    }

    setComponent(world.ecs, eid, Velocity, { x: velocityX, y: velocityY });
  }
}
