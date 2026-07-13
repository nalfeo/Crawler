import { describe, expect, it } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { selectBossSpawnPlacement } from '../../src/game/boss-spawn-placement.js';
import {
  BiomeType,
  RoomRole,
  TilePresets,
  type DoorLocation,
  type MapConfig,
  type RoomData,
} from '../../src/shared/map-types.js';

function makeBossRoom(
  width: number,
  height: number,
  doors: readonly Omit<DoorLocation, 'connectsTo'>[] = [],
  blockedInterior: readonly { x: number; y: number }[] = [],
): { floorMap: FloorMap; room: RoomData } {
  const tileMap = new TileMap(width, height);
  const blocked = new Set(blockedInterior.map(({ x, y }) => `${x},${y}`));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      tileMap.setFlags(
        x,
        y,
        border || blocked.has(`${x},${y}`) ? TilePresets.WALL : TilePresets.FLOOR,
      );
    }
  }
  const roomGraph = new RoomGraph();
  const roomId = roomGraph.add(
    { x: 0, y: 0, width, height },
    doors.map((door) => ({ ...door, connectsTo: -1 })),
    [],
    RoomRole.BOSS_STAIR,
  );
  for (const door of doors) {
    tileMap.setFlags(door.x, door.y, TilePresets.DOOR_OPEN);
  }
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [width, width],
    roomHeightRange: [height, height],
    maxRooms: 1,
    floorDensity: 1,
  };
  const floorMap = new FloorMap(config, tileMap, roomGraph, new Uint8Array(width * height), {
    x: 1,
    y: 1,
  });
  return { floorMap, room: roomGraph.get(roomId)! };
}

describe('selectBossSpawnPlacement', () => {
  it('maximizes the minimum distance from the player and every room door', () => {
    const { floorMap, room } = makeBossRoom(9, 9, [
      { x: 0, y: 4 },
      { x: 4, y: 0 },
    ]);
    const playerPosition = floorMap.tileToWorld(2, 4);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.preferredMinimumSatisfied).toBe(true);
    expect(placement.nearestDoorDistanceFt).not.toBeNull();
    for (let y = 1; y < 8; y += 1) {
      for (let x = 1; x < 8; x += 1) {
        const position = floorMap.tileToWorld(x, y);
        const playerDistance = Math.hypot(
          position.x - playerPosition.x,
          position.y - playerPosition.y,
        );
        const nearestDoorDistance = Math.min(
          ...room.doors.map((door) => {
            const doorPosition = floorMap.tileToWorld(door.x, door.y);
            return Math.hypot(position.x - doorPosition.x, position.y - doorPosition.y);
          }),
        );
        expect(placement.safetyFt).toBeGreaterThanOrEqual(
          Math.min(playerDistance, nearestDoorDistance),
        );
      }
    }
  });

  it('uses center proximity then row-major order for equal-safety ties', () => {
    const { floorMap, room } = makeBossRoom(7, 7);
    const playerPosition = floorMap.tileToWorld(3, 3);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.tile).toEqual({ x: 1, y: 1 });
    expect(placement.nearestDoorDistanceFt).toBeNull();
  });

  it('rejects safer-looking tiles disconnected inside the sealed room', () => {
    const dividingWall = Array.from({ length: 7 }, (_, index) => ({ x: 4, y: index + 1 }));
    const { floorMap, room } = makeBossRoom(9, 9, [{ x: 0, y: 4 }], dividingWall);
    const playerPosition = floorMap.tileToWorld(2, 4);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.tile.x).toBeLessThan(4);
  });

  it('uses the safest legal fallback when the preferred minimum is impossible', () => {
    const { floorMap, room } = makeBossRoom(5, 5, [{ x: 2, y: 0 }]);
    const playerPosition = floorMap.tileToWorld(2, 2);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.preferredMinimumSatisfied).toBe(false);
    expect(placement.safetyFt).toBeLessThan(8);
    expect(floorMap.tileMap.isPassable(placement.tile.x, placement.tile.y)).toBe(true);
    expect(floorMap.roomGraph.getRoomAt(placement.tile.x, placement.tile.y)).toBe(room.id);
  });

  it('dynamic barrier overlay on every tile cannot crash or alter structural placement', () => {
    const { floorMap, room } = makeBossRoom(9, 9, [
      { x: 0, y: 4 },
      { x: 4, y: 0 },
    ]);
    const playerPosition = floorMap.tileToWorld(2, 4);

    // Baseline without barriers.
    const baseline = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    // Install an always-true barrier lookup — every tile appears dynamically blocked.
    floorMap.setBarrierLookup(() => true);
    floorMap.setBarrierPointLookup(() => true);

    // Must not throw, and result must be identical (barriers are structural no-ops).
    const withBarriers = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);
    expect(withBarriers.tile).toEqual(baseline.tile);
    expect(withBarriers.safetyFt).toBe(baseline.safetyFt);
  });

  it('uses an occupied declared doorway as the sealed-room flood origin', () => {
    const { floorMap, room } = makeBossRoom(9, 9, [
      { x: 0, y: 4 },
      { x: 4, y: 0 },
    ]);
    const playerPosition = floorMap.tileToWorld(0, 4);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.preferredMinimumSatisfied).toBe(true);
    expect(floorMap.roomGraph.getRoomAt(placement.tile.x, placement.tile.y)).toBe(room.id);
    expect(room.doors).not.toContainEqual({ ...placement.tile, connectsTo: -1 });
  });

  it('uses an occupied passable perimeter entry as the sealed-room flood origin', () => {
    const { floorMap, room } = makeBossRoom(9, 9, [{ x: 0, y: 4 }]);
    floorMap.tileMap.setFlags(0, 3, TilePresets.FLOOR);
    const playerPosition = floorMap.tileToWorld(0, 3);

    const placement = selectBossSpawnPlacement(floorMap, room, playerPosition, 8);

    expect(placement.preferredMinimumSatisfied).toBe(true);
    expect(placement.tile).not.toEqual({ x: 0, y: 3 });
    expect(floorMap.roomGraph.getRoomAt(placement.tile.x, placement.tile.y)).toBe(room.id);
  });

  it('fails explicitly when the player is not on a reachable room tile', () => {
    const { floorMap, room } = makeBossRoom(5, 5, [], [{ x: 2, y: 2 }]);
    const playerPosition = floorMap.tileToWorld(2, 2);

    expect(() => selectBossSpawnPlacement(floorMap, room, playerPosition, 8)).toThrow(
      /player tile .* is not a reachable interior tile/,
    );
  });
});
