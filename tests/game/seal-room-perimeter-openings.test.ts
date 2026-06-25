import { describe, it, expect } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { sealRoomPerimeterOpenings } from '../../src/game/floor1Scenario.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import {
  DEFAULT_MAP_CONFIG,
  TerrainType,
  TileFlags,
  TilePresets,
} from '../../src/shared/map-types.js';

const WIDTH = 14;
const HEIGHT = 7;

/**
 * Build a small synthetic floor with a single objective room:
 *
 *   spawn(1,3) → corridor → DOOR(4,3) → room interior → BREACH(8,3) → side area
 *
 * The room is entered legitimately through the door on its left wall, but its
 * right wall also has a passable non-door "breach" at (8,3) — exactly the kind
 * of tunnel-carved opening `sealRoomPerimeterOpenings` is meant to wall off.
 *
 * When `breachLeadsToSideArea` is true, the tiles past the breach (9..12,3) are
 * the ONLY route from spawn to that side area, so sealing the breach would
 * isolate it. When false the breach leads straight into wall, so sealing it
 * removes nothing but the breach tile itself.
 */
function buildWorld(breachLeadsToSideArea: boolean) {
  const config = { ...DEFAULT_MAP_CONFIG, widthTiles: WIDTH, heightTiles: HEIGHT };
  const tileMap = new TileMap(WIDTH, HEIGHT);
  tileMap.fill(TilePresets.WALL);
  const terrain = new Uint8Array(WIDTH * HEIGHT);
  terrain.fill(TerrainType.STONE_WALL);

  const idx = (x: number, y: number): number => y * WIDTH + x;
  const carveFloor = (x: number, y: number): void => {
    tileMap.flags[idx(x, y)] = TilePresets.FLOOR;
    terrain[idx(x, y)] = TerrainType.STONE_FLOOR;
  };
  const carveDoor = (x: number, y: number): void => {
    tileMap.flags[idx(x, y)] = TilePresets.DOOR_OPEN;
    terrain[idx(x, y)] = TerrainType.STONE_FLOOR;
  };

  // Spawn corridor leading up to the room door.
  carveFloor(1, 3);
  carveFloor(2, 3);
  carveFloor(3, 3);
  carveDoor(4, 3);

  // Room interior (5..7, 2..4) — bounds are (4,1,5x5), interior is inset by 1.
  for (let ty = 2; ty <= 4; ty += 1) {
    for (let tx = 5; tx <= 7; tx += 1) {
      carveFloor(tx, ty);
    }
  }

  // Non-door perimeter breach on the room's right wall.
  carveFloor(8, 3);

  // Optionally a side area reachable only THROUGH the breach.
  if (breachLeadsToSideArea) {
    carveFloor(9, 3);
    carveFloor(10, 3);
    carveFloor(11, 3);
    carveFloor(12, 3);
  }

  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 4, y: 1, width: 5, height: 5 }, [{ x: 4, y: 3, connectsTo: -1 }]);

  const floorMap = new FloorMap(config, tileMap, roomGraph, terrain, { x: 1, y: 3 });
  const world = createTestWorld();
  world.floorMap = floorMap;

  return { world, floorMap, breachIdx: idx(8, 3) };
}

describe('sealRoomPerimeterOpenings connectivity guard', () => {
  it('seals a breach when doing so isolates nothing reachable', () => {
    const { world, floorMap, breachIdx } = buildWorld(false);

    sealRoomPerimeterOpenings(world, {
      x: 6 * DEFAULT_MAP_CONFIG.tileSizePx,
      y: 3 * DEFAULT_MAP_CONFIG.tileSizePx,
    });

    const flags = floorMap.tileMap.flags[breachIdx]!;
    expect(flags & TileFlags.PASSABLE).toBe(0);
    expect(flags).toBe(TilePresets.WALL);
    expect(floorMap.terrain[breachIdx]).toBe(TerrainType.STONE_WALL);
  });

  it('leaves a breach open when sealing it would isolate a side region', () => {
    const { world, floorMap, breachIdx } = buildWorld(true);

    sealRoomPerimeterOpenings(world, {
      x: 6 * DEFAULT_MAP_CONFIG.tileSizePx,
      y: 3 * DEFAULT_MAP_CONFIG.tileSizePx,
    });

    // The room's own door stays reachable either way, so the old target-room-only
    // guard would have sealed here and stranded tiles 9..12. The global guard
    // must instead leave the breach passable.
    const flags = floorMap.tileMap.flags[breachIdx]!;
    expect(flags & TileFlags.PASSABLE).not.toBe(0);

    const sideAreaIdx = 3 * WIDTH + 12;
    expect(floorMap.tileMap.flags[sideAreaIdx]! & TileFlags.PASSABLE).not.toBe(0);
  });
});
