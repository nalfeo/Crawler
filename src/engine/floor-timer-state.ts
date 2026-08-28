import type { GameWorld } from '../core/world.js';
import { resolveFloorTimerDeadlineMs } from '../core/floor-timer.js';
import { FLOOR } from '../shared/constants.js';

export function resolveFloorTimerRemainingMs(world: GameWorld): number {
  if (world.floorScenario?.objective) {
    return Math.max(0, world.floorScenario.objective.deadlineMs - world.elapsedMs);
  }
  // Manifest-timer floors carry their safe-room pause as banked credit rather
  // than a mutable deadline, so the HUD must read the same credited deadline the
  // scenario collapses on — otherwise the countdown keeps ticking down inside a
  // safe room the floor has already stopped timing.
  const deadlineMs =
    resolveFloorTimerDeadlineMs(world, `floor${world.floor}`) ??
    FLOOR.MAX_DURATION_S * 1000 + world.safeRoomTimerCreditMs;
  return Math.max(0, deadlineMs - world.elapsedMs);
}
