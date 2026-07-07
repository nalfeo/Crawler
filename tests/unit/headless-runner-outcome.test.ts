import { describe, expect, it } from 'vitest';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import { classifyGameOverOutcome } from '../../src/game/ai/headless-runner.js';
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
    world.goalFlags.set('floor2-timeout', true);
    expect(classifyGameOverOutcome(world)).toBe('timeout');
  });

  it('returns death when no timeout marker is present', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    world.floorScenario = null;
    world.goalFlags.set('floor2-timeout', false);
    expect(classifyGameOverOutcome(world)).toBe('death');
  });
});
