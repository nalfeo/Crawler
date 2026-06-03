import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';

/**
 * Run one complete game loop tick — all systems in production order.
 * Systems will be registered here as they are created.
 */
export function runSimFrame(world: GameWorld): void {
  world.frameCount++;
  world.elapsedMs += GAME.DELTA_MS;
  // Systems will be added here as they are implemented:
  // movementSystem(world);
  // combatSystem(world);
  // healthSystem(world);
  // etc.
}
