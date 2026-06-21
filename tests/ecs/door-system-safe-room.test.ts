import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { DoorState } from '../../src/core/components.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const MAP_CFG: MapConfig = {
  widthTiles: 12,
  heightTiles: 12,
  tileSizePx: 32,
  biome: BiomeType.DUNGEON,
  seed: 1,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 2,
  floorDensity: 0.5,
};

/**
 * Safe room covering tiles (1,1)–(4,4) with a single door at tile (3,3).
 * The door sits diagonally (manhattan distance 2) from a player at (2,2):
 * close enough to fall inside the 3×3 auto-open window, but far enough that
 * the safe-room "keep doorway open while transitioning" guard does not fire.
 */
function makeMapWithSafeRoomDoor(): FloorMap {
  const w = 12;
  const h = 12;
  const tileMap = new TileMap(w, h);
  for (let i = 0; i < w * h; i += 1) {
    tileMap.flags[i] = TilePresets.FLOOR;
  }
  tileMap.flags[3 * w + 3] = TilePresets.DOOR_CLOSED;

  const graph = new RoomGraph();
  graph.add(
    { x: 1, y: 1, width: 4, height: 4 },
    [{ x: 3, y: 3, connectsTo: 1 }],
    [],
    RoomRole.SAFE,
  );
  return new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(w * h), { x: 2, y: 2 });
}

describe('doorSystem safe-room forced-close behaviour', () => {
  it('forces safe-room doors closed when the player is inside but not in the doorway', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player at tile (2,2) → pixel centre (80, 80), inside the safe room.
    spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);

    const door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 3, tileY: 3, isOpen: 1, isLocked: 0 }));

    doorSystem(world);

    expect(world.stores.doorState.isOpen[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(false);
  });

  it('keeps the doorway open while the player stands adjacent to a safe-room door', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player at tile (3,2) → adjacent (manhattan 1) to the door at (3,3).
    spawnPlayer(world, 3 * 32 + 16, 2 * 32 + 16);

    const door = addEntity(world.ecs);
    addComponent(world.ecs, door, set(DoorState, { tileX: 3, tileY: 3, isOpen: 1, isLocked: 0 }));

    doorSystem(world);

    // The doorway guard keeps the safe-room door open (not forced closed).
    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(true);
  });
});
