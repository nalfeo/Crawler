import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  BiomeType,
  TerrainType,
  TilePresets,
  type FloorMapData,
  type MapConfig,
} from '../../src/shared/map-types.js';
import {
  buildPassageRenderPlan,
  measurePassageJaggedness,
} from '../../src/engine/terrain/passage-smoothing.js';

function makeFloorMap(rows: readonly string[]): FloorMapData {
  const heightTiles = rows.length;
  const widthTiles = rows[0]?.length ?? 0;
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 8,
    floorDensity: 0.4,
  };

  for (let y = 0; y < heightTiles; y++) {
    const row = rows[y]!;
    for (let x = 0; x < widthTiles; x++) {
      const idx = y * widthTiles + x;
      const cell = row[x] ?? '#';
      switch (cell) {
        case '.':
          terrain[idx] = TerrainType.STONE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        case 'c':
          terrain[idx] = TerrainType.CORRIDOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        case 'd':
          terrain[idx] = TerrainType.DOOR;
          tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
          break;
        case 'v':
          terrain[idx] = TerrainType.CAVE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
          break;
        default:
          terrain[idx] = TerrainType.STONE_WALL;
          tileMap.flags[idx] = TilePresets.WALL;
          break;
      }
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: 1 });
}

describe('passage smoothing helpers', () => {
  it('builds corridor and cave render groups from passage-like terrain', () => {
    const floorMap = makeFloorMap([
      '########',
      '#ccdc###',
      '###c####',
      '###vv###',
      '###vv###',
      '########',
    ]);

    const plan = buildPassageRenderPlan(floorMap);

    expect(plan.includedTiles).toBeGreaterThan(0);
    expect(plan.groups.map((group) => group.terrain).sort()).toEqual([
      TerrainType.CAVE_FLOOR,
      TerrainType.CORRIDOR,
    ]);
  });

  it('cuts deterministic diagonal jaggedness by at least 60% on a staircase corridor', () => {
    const floorMap = makeFloorMap([
      '##########',
      '#c########',
      '##c#######',
      '###c######',
      '####c#####',
      '#####c####',
      '######c###',
      '#######c##',
      '########c#',
      '##########',
    ]);

    const report = measurePassageJaggedness(floorMap);

    expect(report.includedTiles).toBeGreaterThan(0);
    expect(report.baselineRoughness).toBeGreaterThan(report.smoothRoughness);
    expect(report.reduction).toBeGreaterThanOrEqual(0.6);
  });
});
