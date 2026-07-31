import { describe, expect, it } from 'vitest';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import { classifyGameOverOutcome } from '../../src/game/ai/headless-runner-invariants.js';
import { FLOOR2_TIMEOUT_GOAL_ID } from '../../src/game/floor2Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('classifyGameOverOutcome', () => {
  it('returns timeout for floor1 stair timeout failReason', () => {
    const world = createTestWorld({ seed: 42, floor: 1 });
    world.floorScenario = {
      failReason: 'stair_timeout',
    } as unknown as FloorScenarioState;
    expect(classifyGameOverOutcome(world)).toBe('timeout');
  });

  it('returns timeout for floor2 collapse timeout goal flag', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorScenario = null;
    world.goalFlags.set(FLOOR2_TIMEOUT_GOAL_ID, true);
    expect(classifyGameOverOutcome(world)).toBe('timeout');
  });

  it('returns death when no timeout marker is present', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorScenario = null;
    world.goalFlags.set(FLOOR2_TIMEOUT_GOAL_ID, false);
    expect(classifyGameOverOutcome(world)).toBe('death');
  });
});
