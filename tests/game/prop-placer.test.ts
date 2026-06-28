import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { Position, Prop } from '../../src/core/components.js';
import {
  buildNormalRoomMask,
  buildSpecialRoomMask,
  placePropsForFloor,
  resolveCandidates,
} from '../../src/game/systems/propPlacer.js';
import {
  DECORATION_DEFS,
  DECORATION_INDEX_TO_ID,
  type PropCategory,
} from '../../src/shared/decorationDefs.js';
import { BiomeType, RoomRole, TerrainType, TilePresets } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';

function buildFixtureFloorMap(): FloorMap {
  const width = 8;
  const height = 8;
  const tileMap = new TileMap(width, height);
  const terrain = new Uint8Array(width * height);
  tileMap.fill(TilePresets.WALL);
  terrain.fill(TerrainType.STONE_WALL);

  const carveFloor = (tx: number, ty: number, type: TerrainType): void => {
    const idx = ty * width + tx;
    terrain[idx] = type;
    tileMap.setFlags(tx, ty, TilePresets.FLOOR);
  };

  for (let ty = 1; ty <= 3; ty++) {
    for (let tx = 1; tx <= 3; tx++) {
      carveFloor(tx, ty, TerrainType.STONE_FLOOR);
    }
  }
  for (let ty = 1; ty <= 2; ty++) {
    for (let tx = 5; tx <= 6; tx++) {
      carveFloor(tx, ty, TerrainType.STONE_FLOOR);
    }
  }
  for (let tx = 1; tx <= 6; tx++) {
    carveFloor(tx, 5, TerrainType.CORRIDOR);
  }
  for (let ty = 6; ty <= 7; ty++) {
    for (let tx = 5; tx <= 6; tx++) {
      carveFloor(tx, ty, TerrainType.CAVE_FLOOR);
    }
  }

  const rooms = new RoomGraph();
  rooms.add({ x: 1, y: 1, width: 3, height: 3 }, [], [], RoomRole.NORMAL);
  rooms.add({ x: 5, y: 1, width: 2, height: 2 }, [], [], RoomRole.SPAWN);

  return new FloorMap(
    {
      widthTiles: width,
      heightTiles: height,
      tileSizeFt: 4,
      biome: BiomeType.DUNGEON,
      seed: 42,
      roomWidthRange: [3, 3],
      roomHeightRange: [3, 3],
      maxRooms: 2,
      floorDensity: 0.5,
    },
    tileMap,
    rooms,
    terrain,
    { x: 2, y: 2 },
  );
}

function hasAdjacentWall(floorMap: FloorMap, tx: number, ty: number): boolean {
  const adjacentOffsets: Array<readonly [number, number]> = [
    [tx - 1, ty],
    [tx + 1, ty],
    [tx, ty - 1],
    [tx, ty + 1],
  ];
  for (const [nx, ny] of adjacentOffsets) {
    if (nx < 0 || ny < 0 || nx >= floorMap.width || ny >= floorMap.height) continue;
    const t = floorMap.terrain[ny * floorMap.width + nx];
    if (t === TerrainType.STONE_WALL || t === TerrainType.CAVE_WALL) return true;
  }
  return false;
}

function collectPropSnapshot(
  world: ReturnType<typeof createTestWorld>,
  floorMap: FloorMap,
  onProp?: (zone: string, roomRole: RoomRole | undefined, tileX: number, tileY: number) => void,
): string[] {
  const snapshot: string[] = [];
  for (const eid of query(world.ecs, [Prop, Position])) {
    const defIdIndex = world.stores.prop.defIdIndex[eid];
    if (defIdIndex === undefined) continue;
    const defId = DECORATION_INDEX_TO_ID[defIdIndex];
    if (defId === undefined) continue;
    const def = DECORATION_DEFS.get(defId);
    if (!def) continue;

    const x = world.stores.position.x[eid];
    const y = world.stores.position.y[eid];
    if (x === undefined || y === undefined) {
      throw new Error(`Missing Position store values for prop eid ${eid}`);
    }
    const tile = floorMap.worldToTile(x, y);
    const room = floorMap.rooms.find(
      (r) =>
        tile.x >= r.bounds.x &&
        tile.x < r.bounds.x + r.bounds.width &&
        tile.y >= r.bounds.y &&
        tile.y < r.bounds.y + r.bounds.height,
    );
    onProp?.(def.placementZone, room?.role, tile.x, tile.y);
    snapshot.push(`${def.id}:${tile.x},${tile.y}:${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return snapshot.sort();
}

describe('prop placer', () => {
  it('resolves each placement zone to valid tile candidates', () => {
    const floorMap = buildFixtureFloorMap();
    const specialMask = buildSpecialRoomMask(floorMap);
    const normalRoomMask = buildNormalRoomMask(floorMap);

    const anywhere = resolveCandidates(floorMap, 'anywhere', specialMask, normalRoomMask);
    const roomOnly = resolveCandidates(floorMap, 'room-only', specialMask, normalRoomMask);
    const caveOnly = resolveCandidates(floorMap, 'cave-only', specialMask, normalRoomMask);
    const corridorOnly = resolveCandidates(floorMap, 'corridor-only', specialMask, normalRoomMask);
    const wallAdjacent = resolveCandidates(floorMap, 'wall-adjacent', specialMask, normalRoomMask);

    expect(anywhere.length).toBeGreaterThan(0);
    for (const { tx, ty } of anywhere) {
      const room = floorMap.rooms.find(
        (r) =>
          tx >= r.bounds.x &&
          tx < r.bounds.x + r.bounds.width &&
          ty >= r.bounds.y &&
          ty < r.bounds.y + r.bounds.height,
      );
      expect(room?.role).not.toBe(RoomRole.SPAWN);
      expect(room?.role).not.toBe(RoomRole.SAFE);
      expect(room?.role).not.toBe(RoomRole.BOSS_STAIR);
    }

    expect(roomOnly.length).toBeGreaterThan(0);
    for (const { tx, ty } of roomOnly) {
      const room = floorMap.rooms.find(
        (r) =>
          tx >= r.bounds.x &&
          tx < r.bounds.x + r.bounds.width &&
          ty >= r.bounds.y &&
          ty < r.bounds.y + r.bounds.height,
      );
      expect(room?.role).toBe(RoomRole.NORMAL);
    }

    expect(caveOnly.length).toBeGreaterThan(0);
    for (const { tx, ty } of caveOnly) {
      expect(floorMap.terrain[ty * floorMap.width + tx]).toBe(TerrainType.CAVE_FLOOR);
    }

    expect(corridorOnly.length).toBeGreaterThan(0);
    for (const { tx, ty } of corridorOnly) {
      expect(floorMap.terrain[ty * floorMap.width + tx]).toBe(TerrainType.CORRIDOR);
    }

    expect(wallAdjacent.length).toBeGreaterThan(0);
    for (const { tx, ty } of wallAdjacent) {
      expect(hasAdjacentWall(floorMap, tx, ty)).toBe(true);
    }
  });

  it('places props in deterministic, zone-valid tiles', () => {
    const config = {
      biomeTag: 'dungeon' as const,
      allowedCategories: ['rubbish', 'light-source', 'structural'] as PropCategory[],
      densityMultiplier: 1000,
    };
    const floorMapA = buildFixtureFloorMap();
    const floorMapB = buildFixtureFloorMap();
    const worldA = createTestWorld({ seed: 42 });
    const worldB = createTestWorld({ seed: 42 });

    placePropsForFloor(worldA, floorMapA, config, new SeededRandom(42));
    placePropsForFloor(worldB, floorMapB, config, new SeededRandom(42));

    const zoneCounts = new Map<string, number>();
    const snapshotA = collectPropSnapshot(worldA, floorMapA, (zone, roomRole, tileX, tileY) => {
      zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
      if (zone === 'anywhere') {
        expect(roomRole).not.toBe(RoomRole.SPAWN);
      } else if (zone === 'room-only') {
        expect(roomRole).toBe(RoomRole.NORMAL);
      } else if (zone === 'wall-adjacent') {
        expect(hasAdjacentWall(floorMapA, tileX, tileY)).toBe(true);
      } else if (zone === 'cave-only') {
        expect(floorMapA.terrain[tileY * floorMapA.width + tileX]).toBe(TerrainType.CAVE_FLOOR);
      }
    });
    const snapshotB = collectPropSnapshot(worldB, floorMapB);

    expect(zoneCounts.get('anywhere')).toBeGreaterThan(0);
    expect(zoneCounts.get('room-only')).toBeGreaterThan(0);
    expect(zoneCounts.get('wall-adjacent')).toBeGreaterThan(0);
    expect(snapshotA).toEqual(snapshotB);
  });

  it('increases placements when densityMultiplier increases', () => {
    const lowWorld = createTestWorld({ seed: 7 });
    const highWorld = createTestWorld({ seed: 7 });
    const low = placePropsForFloor(
      lowWorld,
      buildFixtureFloorMap(),
      {
        biomeTag: 'dungeon',
        allowedCategories: ['rubbish', 'light-source', 'structural'],
        densityMultiplier: 1,
      },
      new SeededRandom(7),
    ).length;
    const high = placePropsForFloor(
      highWorld,
      buildFixtureFloorMap(),
      {
        biomeTag: 'dungeon',
        allowedCategories: ['rubbish', 'light-source', 'structural'],
        densityMultiplier: 1000,
      },
      new SeededRandom(7),
    ).length;

    expect(high).toBeGreaterThan(low);
  });
});
