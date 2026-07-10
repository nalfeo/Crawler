import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem';
import { createTestWorld } from '../helpers/world-factory';
import { spawnPlayer } from '../../src/core/helpers';
import { DoorState } from '../../src/core/components';
import { addItem } from '../../src/shared/inventory';
import { setDoorLockConfig, setGoalFlag } from '../../src/core/door-lock';
import { makeMapWithDoor } from '../helpers/map-fixtures';
import type { GameWorld } from '../../src/core/world';

describe('door lock conditions', () => {
  let world: GameWorld;
  let player: number;
  let door: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    world.floorMap = makeMapWithDoor();
    player = spawnPlayer(world, 0, 0);
    door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 5, tileY: 5, logicalOpen: 0, isLocked: 1 }),
    );
  });

  it('unlocks when inventory condition is satisfied', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'all',
        conditions: [
          { type: 'inventory', itemId: 'floor-key-bronze', quantity: 1, holderEid: player },
        ],
      },
    });

    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);

    const bag = world.inventories.get(player)!;
    addItem(bag, 'floor-key-bronze', 1);
    doorSystem(world);

    expect(world.stores.doorState.isLocked[door]).toBe(0);
    expect(world.stores.doorState.logicalOpen[door]).toBe(1);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(true);
  });

  it('unlocks when goal condition is satisfied', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'quest.main.completed' }],
      },
    });

    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);

    setGoalFlag(world, 'quest.main.completed', true);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
  });

  it('unlocks when timer condition is satisfied', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'timer', elapsedMs: 200 }],
      },
    });

    world.elapsedMs = 199;
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);

    world.elapsedMs = 200;
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
  });

  it('supports ALL unlock operator', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'all',
        conditions: [
          { type: 'goal', goalId: 'goal.all' },
          { type: 'inventory', itemId: 'floor-key-bronze', quantity: 1, holderEid: player },
        ],
      },
    });

    const bag = world.inventories.get(player)!;
    addItem(bag, 'floor-key-bronze', 1);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);

    setGoalFlag(world, 'goal.all', true);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
  });

  it('supports ANY unlock operator', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'any',
        conditions: [
          { type: 'goal', goalId: 'goal.any' },
          { type: 'inventory', itemId: 'floor-key-bronze', quantity: 1, holderEid: player },
        ],
      },
    });

    const bag = world.inventories.get(player)!;
    addItem(bag, 'floor-key-bronze', 1);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
  });

  it('relocks when optional secondary conditions are satisfied', () => {
    setDoorLockConfig(world, door, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'goal.unlock' }],
      },
      relock: {
        operator: 'all',
        conditions: [{ type: 'timer', elapsedMs: 500 }],
      },
    });

    setGoalFlag(world, 'goal.unlock', true);
    world.elapsedMs = 100;
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(true);

    world.elapsedMs = 500;
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);
    expect(world.stores.doorState.logicalOpen[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(false);

    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);
  });
});
