import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDoorAwarePassable,
  describeDoorUnlock,
  getDoorNavInfos,
  getNavigationBlockedDoors,
} from '../../src/core/door-navigation';
import { setDoorLockConfig, setGoalFlag, type DoorConditionGroup } from '../../src/core/door-lock';
import { DoorState } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TileMap } from '../../src/core/map/TileMap';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types';
import { createTestWorld } from '../helpers/world-factory';
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
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const idx = y * 10 + x;
      tileMap.flags[idx] =
        x === 0 || x === 9 || y === 0 || y === 9 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  tileMap.flags[5 * 10 + 5] = TilePresets.DOOR_CLOSED;
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(100), { x: 3, y: 3 });
}

function spawnDoor(world: GameWorld, tileX: number, tileY: number): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(DoorState, { tileX, tileY, isOpen: 0, isLocked: 1 }));
  return eid;
}

describe('door-navigation', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    world.floorMap = makeMapWithDoor();
  });

  describe('describeDoorUnlock', () => {
    it('returns empty lists for undefined group', () => {
      expect(describeDoorUnlock(undefined)).toEqual({ goalIds: [], itemIds: [], timerMs: [] });
    });

    it('flattens goal, inventory and timer conditions', () => {
      const group: DoorConditionGroup = {
        operator: 'all',
        conditions: [
          { type: 'goal', goalId: 'g1' },
          { type: 'inventory', itemId: 'floor-key-bronze', quantity: 1 },
          { type: 'timer', elapsedMs: 1000 },
        ],
      };
      expect(describeDoorUnlock(group)).toEqual({
        goalIds: ['g1'],
        itemIds: ['floor-key-bronze'],
        timerMs: [1000],
      });
    });
  });

  describe('getDoorNavInfos', () => {
    it('returns an unconfigured door as never navigation-blocked', () => {
      spawnDoor(world, 5, 5);
      const infos = getDoorNavInfos(world);
      expect(infos).toHaveLength(1);
      const [info] = infos;
      expect(info).toBeDefined();
      expect(info).toMatchObject({
        tileX: 5,
        tileY: 5,
        isLocked: true,
        navigationBlocked: false,
      });
      expect(info!.unlock).toBeUndefined();
      expect(info!.unlockRequirement).toEqual({ goalIds: [], itemIds: [], timerMs: [] });
    });

    it('marks a configured door blocked until the unlock condition is met', () => {
      const door = spawnDoor(world, 5, 5);
      setDoorLockConfig(world, door, {
        unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'open-sesame' }] },
      });
      const lockedInfo = getDoorNavInfos(world)[0];
      expect(lockedInfo).toBeDefined();
      expect(lockedInfo!.navigationBlocked).toBe(true);

      setGoalFlag(world, 'open-sesame', true);
      const unlockedInfo = getDoorNavInfos(world)[0];
      expect(unlockedInfo).toBeDefined();
      expect(unlockedInfo!.navigationBlocked).toBe(false);
    });

    it('marks a door blocked again when its relock condition becomes satisfied', () => {
      const door = spawnDoor(world, 5, 5);
      setGoalFlag(world, 'unlocked', true);
      setDoorLockConfig(world, door, {
        unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'unlocked' }] },
        relock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'relocked' }] },
      });
      const unlockedInfo = getDoorNavInfos(world)[0];
      expect(unlockedInfo).toBeDefined();
      expect(unlockedInfo!.navigationBlocked).toBe(false);

      setGoalFlag(world, 'relocked', true);
      const relockedInfo = getDoorNavInfos(world)[0];
      expect(relockedInfo).toBeDefined();
      expect(relockedInfo!.navigationBlocked).toBe(true);
    });
  });

  describe('getNavigationBlockedDoors', () => {
    it('returns only the blocked subset', () => {
      const blocked = spawnDoor(world, 5, 5);
      spawnDoor(world, 4, 4);
      setDoorLockConfig(world, blocked, {
        unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'never' }] },
      });
      const result = getNavigationBlockedDoors(world);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeDefined();
      expect(result[0]!.tileX).toBe(5);
    });
  });

  describe('buildDoorAwarePassable', () => {
    it('treats floor tiles as passable and walls as impassable', () => {
      const passable = buildDoorAwarePassable(world);
      expect(passable(3, 3)).toBe(true);
      expect(passable(0, 0)).toBe(false);
    });

    it('treats an unconfigured closed door as passable (auto-opens on approach)', () => {
      spawnDoor(world, 5, 5);
      const passable = buildDoorAwarePassable(world);
      expect(passable(5, 5)).toBe(true);
    });

    it('treats a locked-unsatisfied configured door as a wall', () => {
      const door = spawnDoor(world, 5, 5);
      setDoorLockConfig(world, door, {
        unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'locked-forever' }] },
      });
      const passable = buildDoorAwarePassable(world);
      expect(passable(5, 5)).toBe(false);
    });

    it('returns an always-false predicate when there is no floor map', () => {
      world.floorMap = null;
      const passable = buildDoorAwarePassable(world);
      expect(passable(3, 3)).toBe(false);
    });
  });
});
