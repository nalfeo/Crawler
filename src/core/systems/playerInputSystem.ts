import { query, setComponent } from 'bitecs';
import { PLAYER_SPEED } from '../../shared/constants.js';
import { normalizeInputDirection, type InputState } from '../../shared/input.js';
import { Player, Velocity } from '../components.js';
import { computeMoveSpeed } from '../movement-speed.js';
import type { GameWorld } from '../world.js';

export function playerInputSystem(world: GameWorld, input: InputState): void {
  const playerEntities = query(world.ecs, [Player, Velocity]);
  const { moveX, moveY } = normalizeInputDirection(input.moveX, input.moveY);

  for (const eid of playerEntities) {
    if (eid === undefined) {
      continue;
    }

    // Full pipeline: baseSpeed * (1 + moveSpeedBonus[DEX/equip/modifiers]) *
    // statusMultiplier (haste/slow) * encumbranceMultiplier (last).
    const moveSpeed = computeMoveSpeed(world, eid, PLAYER_SPEED);

    setComponent(world.ecs, eid, Velocity, { x: moveX * moveSpeed, y: moveY * moveSpeed });
  }
}
