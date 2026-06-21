import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDoorLockConfig,
  evaluateDoorConditionGroup,
  getDoorLockConfig,
  isGoalFlagComplete,
  setDoorLockConfig,
  setGoalFlag,
  type DoorConditionGroup,
} from '../../src/core/door-lock';
import { Inventory } from '../../src/core/components';
import { spawnPlayer } from '../../src/core/helpers';
import { addItem } from '../../src/shared/inventory';
import { createTestWorld } from '../helpers/world-factory';
import type { GameWorld } from '../../src/core/world';

describe('door-lock validation and evaluation', () => {
  let world: GameWorld;
  let door: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 7 });
    door = addEntity(world.ecs);
  });

  describe('setDoorLockConfig validation', () => {
    it('throws when a condition group is empty', () => {
      expect(() =>
        setDoorLockConfig(world, door, { unlock: { operator: 'all', conditions: [] } }),
      ).toThrow(/at least one condition/);
    });

    it('throws when the operator is invalid', () => {
      const bad = {
        operator: 'xor',
        conditions: [{ type: 'timer', elapsedMs: 1 }],
      } as unknown as DoorConditionGroup;
      expect(() => setDoorLockConfig(world, door, { unlock: bad })).toThrow(/operator must be/);
    });

    it('throws when an inventory condition has an empty itemId', () => {
      expect(() =>
        setDoorLockConfig(world, door, {
          unlock: { operator: 'all', conditions: [{ type: 'inventory', itemId: '', quantity: 1 }] },
        }),
      ).toThrow(/non-empty itemId/);
    });

    it('throws when an inventory condition quantity is not positive', () => {
      expect(() =>
        setDoorLockConfig(world, door, {
          unlock: {
            operator: 'all',
            conditions: [{ type: 'inventory', itemId: 'key', quantity: 0 }],
          },
        }),
      ).toThrow(/positive number/);
    });

    it('throws when a goal condition has an empty goalId', () => {
      expect(() =>
        setDoorLockConfig(world, door, {
          unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: '' }] },
        }),
      ).toThrow(/non-empty goalId/);
    });

    it('throws when a timer condition has a negative elapsedMs', () => {
      expect(() =>
        setDoorLockConfig(world, door, {
          unlock: { operator: 'all', conditions: [{ type: 'timer', elapsedMs: -1 }] },
        }),
      ).toThrow(/elapsedMs must be >= 0/);
    });

    it('throws for an unsupported condition type', () => {
      const bad = {
        operator: 'all',
        conditions: [{ type: 'mystery' }],
      } as unknown as DoorConditionGroup;
      expect(() => setDoorLockConfig(world, door, { unlock: bad })).toThrow(
        /Unsupported door lock condition/,
      );
    });

    it('validates the relock group as well', () => {
      expect(() =>
        setDoorLockConfig(world, door, {
          unlock: { operator: 'all', conditions: [{ type: 'timer', elapsedMs: 1 }] },
          relock: { operator: 'all', conditions: [] },
        }),
      ).toThrow(/Door relock condition group must include/);
    });

    it('clones the stored config so external mutation does not leak in', () => {
      const unlock: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'timer', elapsedMs: 100 }],
      };
      setDoorLockConfig(world, door, { unlock });
      const firstCondition = unlock.conditions[0];
      expect(firstCondition).toBeDefined();
      firstCondition!.type = 'goal';
      const stored = getDoorLockConfig(world, door);
      expect(stored).toBeDefined();
      expect(stored!.unlock.conditions[0]).toBeDefined();
      expect(stored!.unlock.conditions[0]!.type).toBe('timer');
    });
  });

  describe('getDoorLockConfig / clearDoorLockConfig', () => {
    it('returns undefined when no config is set', () => {
      expect(getDoorLockConfig(world, door)).toBeUndefined();
    });

    it('clears a previously set config', () => {
      setDoorLockConfig(world, door, {
        unlock: { operator: 'all', conditions: [{ type: 'timer', elapsedMs: 1 }] },
      });
      expect(getDoorLockConfig(world, door)).toBeDefined();
      clearDoorLockConfig(world, door);
      expect(getDoorLockConfig(world, door)).toBeUndefined();
    });
  });

  describe('evaluateDoorConditionGroup', () => {
    it('evaluates timer conditions against elapsedMs', () => {
      world.elapsedMs = 500;
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'timer', elapsedMs: 400 }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(true);
      world.elapsedMs = 100;
      expect(evaluateDoorConditionGroup(world, group)).toBe(false);
    });

    it('evaluates goal conditions against goal flags', () => {
      setGoalFlag(world, 'boss-down', true);
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'boss-down' }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(true);
      expect(
        evaluateDoorConditionGroup(world, {
          operator: 'all',
          conditions: [{ type: 'goal', goalId: 'never-set' }],
        }),
      ).toBe(false);
    });

    it('"any" operator passes when at least one condition is met', () => {
      world.elapsedMs = 0;
      setGoalFlag(world, 'g', true);
      const group: DoorConditionGroup = {
        operator: 'any',
        conditions: [
          { type: 'timer', elapsedMs: 9999 },
          { type: 'goal', goalId: 'g' },
        ],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(true);
    });

    it('inventory condition returns false when no holder has an inventory', () => {
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'inventory', itemId: 'key', quantity: 1 }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(false);
    });

    it('inventory condition resolves the default player holder', () => {
      const player = spawnPlayer(world, 0, 0);
      const bag = world.inventories.get(player);
      if (bag) {
        addItem(bag, 'floor-key-bronze', 2);
      }
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'inventory', itemId: 'floor-key-bronze', quantity: 2 }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(true);
    });

    it('inventory condition with explicit holderEid returns false when holder lacks Inventory', () => {
      const noInventory = addEntity(world.ecs);
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'inventory', itemId: 'key', quantity: 1, holderEid: noInventory }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(false);
    });

    it('inventory condition with explicit holderEid that has Inventory but no bag returns false', () => {
      const holder = addEntity(world.ecs);
      addComponent(world.ecs, holder, set(Inventory, {}));
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [{ type: 'inventory', itemId: 'key', quantity: 1, holderEid: holder }],
      };
      expect(evaluateDoorConditionGroup(world, group)).toBe(false);
    });
  });

  describe('goal flags', () => {
    it('throws when setting a goal flag with an empty id', () => {
      expect(() => setGoalFlag(world, '', true)).toThrow(/non-empty/);
    });

    it('reports goal flag completion state', () => {
      expect(isGoalFlagComplete(world, 'q')).toBe(false);
      setGoalFlag(world, 'q', true);
      expect(isGoalFlagComplete(world, 'q')).toBe(true);
      setGoalFlag(world, 'q', false);
      expect(isGoalFlagComplete(world, 'q')).toBe(false);
    });
  });
});
