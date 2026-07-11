import type { GameWorld } from '../core/world.js';
import { FLOOR } from '../shared/constants.js';
import { getFloorManifest } from '../shared/floor-registry.js';

export function resolveFloorTimerRemainingMs(world: GameWorld): number {
  if (world.floorScenario?.objective) {
    return Math.max(0, world.floorScenario.objective.deadlineMs - world.elapsedMs);
  }
  const manifestDurationMs = getFloorManifest(`floor${world.floor}`)?.timer?.durationMs;
  const maxMs = manifestDurationMs ?? FLOOR.MAX_DURATION_S * 1000;
  return Math.max(0, maxMs - world.elapsedMs);
}
