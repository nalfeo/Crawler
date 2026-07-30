import { describe, expect, it } from 'vitest';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import {
  classifyGameOverOutcome,
  collectEquipmentPlayabilityViolations,
} from '../../src/game/ai/headless-runner-invariants.js';
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

  describe('collectEquipmentPlayabilityViolations', () => {
    it('flags runs that spend equipment gold but end with no generated equipment', () => {
      const violations = collectEquipmentPlayabilityViolations({
        goldSpentOnEquipment: 120,
        baggedGeneratedCount: 0,
        equippedGeneratedCount: 0,
        unopenedRewardBoxes: 0,
        unequippedWithEmptySlotCount: 0,
      });
      expect(violations).toContain(
        'Spent 120 gold on equipment but ended with no generated equipment bagged or equipped',
      );
    });

    it('flags runs that end with unopened rewards', () => {
      const violations = collectEquipmentPlayabilityViolations({
        goldSpentOnEquipment: 0,
        baggedGeneratedCount: 1,
        equippedGeneratedCount: 0,
        unopenedRewardBoxes: 2,
        unequippedWithEmptySlotCount: 0,
      });
      expect(violations).toContain('Run ended with 2 unopened reward boxes');
    });

    it('flags generated gear left bagged while matching slots are empty', () => {
      const violations = collectEquipmentPlayabilityViolations({
        goldSpentOnEquipment: 0,
        baggedGeneratedCount: 1,
        equippedGeneratedCount: 0,
        unopenedRewardBoxes: 0,
        unequippedWithEmptySlotCount: 1,
      });
      expect(violations).toContain(
        '1 generated items remained bagged while a matching slot stayed empty',
      );
    });
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
