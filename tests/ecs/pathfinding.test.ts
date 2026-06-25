import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { findTilePath, PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

function makePathMap(doorOpen: boolean): FloorMap {
  const width = 12;
  const height = 9;
  const tileMap = new TileMap(width, height);
  const terrain = new Uint8Array(width * height);

  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const isPillar = x === 6 && y >= 1 && y <= height - 2 && y !== 4;

      if (isBorder || isPillar) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  tileMap.flags[4 * width + 6] = doorOpen ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED;

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 2, y: 4 });
}

describe('findTilePath', () => {
  it('routes through an open door instead of crossing blocked pillar walls', () => {
    const floorMap = makePathMap(true);
    const path = findTilePath(floorMap, { x: 2, y: 4 }, { x: 9, y: 4 });

    expect(path.length).toBeGreaterThan(0);
    expect(path.some((point) => point.x === 6 && point.y === 4)).toBe(true);
  });

  it('returns no ground path when the only door is closed', () => {
    const floorMap = makePathMap(false);
    const path = findTilePath(floorMap, { x: 2, y: 4 }, { x: 9, y: 4 });

    expect(path).toEqual([]);
  });

  it('allows flying traversal when ground path is blocked by closed structures', () => {
    const floorMap = makePathMap(false);
    const path = findTilePath(
      floorMap,
      { x: 2, y: 4 },
      { x: 9, y: 4 },
      { traversalMode: PATH_TRAVERSAL.FLYING },
    );

    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 2, y: 4 });
    expect(path[path.length - 1]).toEqual({ x: 9, y: 4 });
  });
});
