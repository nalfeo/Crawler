import { describe, it, expect, beforeEach } from 'vitest';
import { addEntity, addComponent, set } from 'bitecs';
import { createTestWorld } from '../../tests/helpers/world-factory';
import { spawnPlayer } from '../../src/core/index';
import { doorSystem } from '../../src/core/systems/doorSystem';
import { DoorState } from '../../src/core/components';
import { FloorMap } from '../../src/core/map/FloorMap';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { TilePresets, BiomeType } from '../../src/shared/map-types';
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

  // Floor everywhere except border walls
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const idx = y * 10 + x;
      if (x === 0 || x === 9 || y === 0 || y === 9) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  // Place a closed door at (5, 5)
  tileMap.flags[5 * 10 + 5] = TilePresets.DOOR_CLOSED;

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 3 });
}

describe('Door System', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
  });

  it('should do nothing when no floorMap exists', () => {
    world.floorMap = null;
    expect(() => doorSystem(world)).not.toThrow();
  });

  it('should do nothing when no door entities exist', () => {
    world.floorMap = makeMapWithDoor();
    expect(() => doorSystem(world)).not.toThrow();
    // Door stays closed
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(false);
  });

  it('should auto-open a nearby closed door for the player', () => {
    world.floorMap = makeMapWithDoor();
    const floorMap = world.floorMap;
    const player = spawnPlayer(world, 0, 0);
    const pixel = floorMap.tileToPixel(4, 5);
    world.stores.position.x[player] = pixel.x;
    world.stores.position.y[player] = pixel.y;

    doorSystem(world);

    expect(floorMap.tileMap.isPassable(5, 5)).toBe(true);
  });

  it('should not auto-open a nearby door that is locked', () => {
    world.floorMap = makeMapWithDoor();
    const floorMap = world.floorMap;
    const player = spawnPlayer(world, 0, 0);
    const pixel = floorMap.tileToPixel(4, 5);
    world.stores.position.x[player] = pixel.x;
    world.stores.position.y[player] = pixel.y;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(DoorState, { tileX: 5, tileY: 5, isOpen: 0, isLocked: 1 }));

    doorSystem(world);

    expect(floorMap.tileMap.isPassable(5, 5)).toBe(false);
    expect(world.stores.doorState.isLocked[eid]).toBe(1);
  });

  it('should open a closed door when isOpen = 1', () => {
    const floorMap = makeMapWithDoor();
    world.floorMap = floorMap;

    // Confirm door is closed
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(false);
    expect(floorMap.tileMap.isDoor(5, 5)).toBe(true);

    // Create door entity with isOpen = 1
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(DoorState, { tileX: 5, tileY: 5, isOpen: 1 }));

    doorSystem(world);

    // Door should now be passable and transparent
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(true);
    expect(floorMap.tileMap.isTransparent(5, 5)).toBe(true);
    expect(floorMap.tileMap.isDoor(5, 5)).toBe(true);
  });

  it('should close an open door when isOpen = 0', () => {
    const floorMap = makeMapWithDoor();
    world.floorMap = floorMap;

    // Open the door first
    floorMap.tileMap.openDoor(5, 5);
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(true);

    // Create door entity with isOpen = 0
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(DoorState, { tileX: 5, tileY: 5, isOpen: 0 }));

    doorSystem(world);

    // Door should be closed
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(false);
    expect(floorMap.tileMap.isTransparent(5, 5)).toBe(false);
    expect(floorMap.tileMap.isDoor(5, 5)).toBe(true);
  });

  it('should handle multiple door entities', () => {
    const floorMap = makeMapWithDoor();
    // Add a second door at (3, 3)
    floorMap.tileMap.flags[3 * 10 + 3] = TilePresets.DOOR_CLOSED;
    world.floorMap = floorMap;

    // Door 1: open at (5,5)
    const eid1 = addEntity(world.ecs);
    addComponent(world.ecs, eid1, set(DoorState, { tileX: 5, tileY: 5, isOpen: 1 }));

    // Door 2: closed at (3,3)
    const eid2 = addEntity(world.ecs);
    addComponent(world.ecs, eid2, set(DoorState, { tileX: 3, tileY: 3, isOpen: 0 }));

    doorSystem(world);

    expect(floorMap.tileMap.isPassable(5, 5)).toBe(true);
    expect(floorMap.tileMap.isPassable(3, 3)).toBe(false);
  });

  it('should sync door state changes between frames', () => {
    const floorMap = makeMapWithDoor();
    world.floorMap = floorMap;

    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(DoorState, { tileX: 5, tileY: 5, isOpen: 0 }));

    doorSystem(world);
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(false);

    // Toggle open
    world.stores.doorState.isOpen[eid] = 1;
    doorSystem(world);
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(true);

    // Toggle closed again
    world.stores.doorState.isOpen[eid] = 0;
    doorSystem(world);
    expect(floorMap.tileMap.isPassable(5, 5)).toBe(false);
  });
});
