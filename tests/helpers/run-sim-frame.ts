import { healthSystem } from '../../src/core/systems/healthSystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import type { GameWorld } from '../../src/core/world.js';
import { GAME } from '../../src/shared/constants.js';

export function runSimFrame(world: GameWorld): void {
  world.frameCount++;
  world.elapsedMs += GAME.DELTA_MS;
  movementSystem(world);
  healthSystem(world);
}
