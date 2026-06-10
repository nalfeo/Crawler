import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem';
import { createTestWorld } from '../helpers/world-factory';
import { spawnPlayer } from '../../src/core/helpers';
import { DoorState } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TileMap } from '../../src/core/map/TileMap';
import { addItem } from '../../src/shared/inventory';
import { BiomeType, TilePresets } from '../../src/shared/map-types';
import { setDoorLockConfig, setGoalFlag } from '../../src/core/door-lock';
import type { MapConfig } from '../../src/shared/map-types';
import type { GameWorld } from '../../src/core/world';

function makeMapWithDoor(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizePx: 32,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(10, 10);
  const terrain = new Uint8Array(100);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const idx = y * 10 + x;
      if (x === 0 || x === 9 || y === 0 || y === 9) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  tileMap.flags[5 * 10 + 5] = TilePresets.DOOR_CLOSED;
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 3 });
}

describe('door lock conditions', () => {
  let world: GameWorld;
  let player: number;
  let door: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    world.floorMap = makeMapWithDoor();
    player = spawnPlayer(world, 0, 0);
    door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 5, tileY: 5, isOpen: 0, isLocked: 1 }));
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
    expect(world.stores.doorState.isOpen[door]).toBe(1);
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
    expect(world.stores.doorState.isOpen[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(false);

    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);
  });
});
