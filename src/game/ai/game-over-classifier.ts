import type { GameWorld } from '../../core/index.js';
import { FLOOR2_TIMEOUT_GOAL_ID } from '../floor2Scenario.js';

/**
 * Determine whether a completed run ended by timeout or player death.
 * Used by the headless runner and its unit tests to classify run outcomes.
 */
export function classifyGameOverOutcome(world: GameWorld): 'timeout' | 'death' {
  const floor1Timeout = world.floorScenario?.failReason === 'stair_timeout';
  const floor2Timeout = world.goalFlags.get(FLOOR2_TIMEOUT_GOAL_ID) === true;
  return floor1Timeout || floor2Timeout ? 'timeout' : 'death';
}
