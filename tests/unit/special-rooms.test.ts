import { describe, it, expect } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import {
  DEFAULT_MAP_CONFIG,
  RoomRole,
  TerrainType,
  TileFlags,
  TilePresets,
} from '../../src/shared/map-types.js';
import {
  DEFAULT_SPECIAL_ROOM_ROLES,
  sealRoomPerimeter,
  sealSpecialRooms,
} from '../../src/core/map/special-rooms.js';

const WIDTH = 14;
const HEIGHT = 7;

/**
 * Build a small synthetic floor with a single room:
 *
 *   spawn(1,3) → corridor → DOOR(4,3) → room interior → BREACH(8,3) → [side area]
 *
 * The room (bounds 4,1,5x5; interior 5..7 × 2..4) is entered legitimately via the
 * door on its left wall, but its right wall has a passable non-door "breach" at
 * (8,3). When `breachLeadsToSideArea` is true the tiles past the breach (9..12,3)
 * are reachable ONLY through it, so walling the breach would strand them.
 */
function buildFloor(options: { breachLeadsToSideArea: boolean; role: RoomRole }): {
  floorMap: FloorMap;
  roomId: number;
  breachIdx: number;
} {
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

  carveFloor(1, 3);
  carveFloor(2, 3);
  carveFloor(3, 3);
  carveDoor(4, 3);

  for (let ty = 2; ty <= 4; ty += 1) {
    for (let tx = 5; tx <= 7; tx += 1) {
      carveFloor(tx, ty);
    }
  }

  carveFloor(8, 3); // breach on the right wall

  if (options.breachLeadsToSideArea) {
    carveFloor(9, 3);
    carveFloor(10, 3);
    carveFloor(11, 3);
    carveFloor(12, 3);
  }

  const roomGraph = new RoomGraph();
  const roomId = roomGraph.add(
    { x: 4, y: 1, width: 5, height: 5 },
    [{ x: 4, y: 3, connectsTo: -1 }],
    [],
    options.role,
  );

  const floorMap = new FloorMap(config, tileMap, roomGraph, terrain, { x: 1, y: 3 });
  return { floorMap, roomId, breachIdx: idx(8, 3) };
}

describe('sealRoomPerimeter', () => {
  it('walls a harmless breach and reports it', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.SAFE,
    });

    const room = floorMap.roomGraph.get(roomId)!;
    const result = sealRoomPerimeter(floorMap, room);

    const flags = floorMap.tileMap.flags[breachIdx]!;
    expect(flags).toBe(TilePresets.WALL);
    expect(floorMap.terrain[breachIdx]).toBe(TerrainType.STONE_WALL);
    expect(result.walledTiles).toContain(breachIdx);
    expect(result.addedDoors).toHaveLength(0);
  });

  it('converts a load-bearing breach into a door and registers it on the room', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: true,
      role: RoomRole.SAFE,
    });

    const room = floorMap.roomGraph.get(roomId)!;
    const result = sealRoomPerimeter(floorMap, room);

    const flags = floorMap.tileMap.flags[breachIdx]!;
    expect(flags).toBe(TilePresets.DOOR_CLOSED);
    expect(flags & TileFlags.DOOR).not.toBe(0);
    expect(flags & TileFlags.PASSABLE).toBe(0);
    expect(floorMap.terrain[breachIdx]).toBe(TerrainType.DOOR);

    expect(result.walledTiles).not.toContain(breachIdx);
    expect(result.addedDoors).toEqual([{ x: 8, y: 3, connectsTo: -1 }]);
    expect(floorMap.roomGraph.get(roomId)!.doors.some((d) => d.x === 8 && d.y === 3)).toBe(true);

    // Side region past the converted door is untouched and still reachable.
    expect(floorMap.tileMap.flags[3 * WIDTH + 12]! & TileFlags.PASSABLE).not.toBe(0);
  });

  it('is idempotent — a fully enclosed room yields no changes', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.SAFE,
    });
    const room = floorMap.roomGraph.get(roomId)!;
    sealRoomPerimeter(floorMap, room);

    const second = sealRoomPerimeter(floorMap, room);
    expect(second.walledTiles).toHaveLength(0);
    expect(second.addedDoors).toHaveLength(0);
    expect(floorMap.tileMap.flags[breachIdx]).toBe(TilePresets.WALL);
  });
});

describe('sealSpecialRooms', () => {
  it('seals SAFE and BOSS_STAIR rooms by default', () => {
    expect(DEFAULT_SPECIAL_ROOM_ROLES).toEqual([RoomRole.SAFE, RoomRole.BOSS_STAIR]);

    for (const role of [RoomRole.SAFE, RoomRole.BOSS_STAIR]) {
      const { floorMap, roomId, breachIdx } = buildFloor({
        breachLeadsToSideArea: false,
        role,
      });
      const results = sealSpecialRooms(floorMap);
      expect(results.has(roomId)).toBe(true);
      expect(floorMap.tileMap.flags[breachIdx]).toBe(TilePresets.WALL);
    }
  });

  it('leaves NORMAL rooms untouched by default', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.NORMAL,
    });

    const results = sealSpecialRooms(floorMap);
    expect(results.has(roomId)).toBe(false);
    // Breach stays an open floor tile — a NORMAL room is not special.
    expect(floorMap.tileMap.flags[breachIdx]! & TileFlags.PASSABLE).not.toBe(0);
  });

  it('seals a non-special room when passed via extraRoomIds', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.NORMAL,
    });

    const results = sealSpecialRooms(floorMap, { extraRoomIds: [roomId] });
    expect(results.has(roomId)).toBe(true);
    expect(floorMap.tileMap.flags[breachIdx]).toBe(TilePresets.WALL);
  });

  it('opts a room out of sealing via skipRoomIds (seal-by-default override)', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.SAFE,
    });

    const results = sealSpecialRooms(floorMap, { skipRoomIds: new Set([roomId]) });
    expect(results.has(roomId)).toBe(false);
    // The SAFE room is explicitly told NOT to seal, so the breach remains open.
    expect(floorMap.tileMap.flags[breachIdx]! & TileFlags.PASSABLE).not.toBe(0);
  });

  it('honours a custom role list', () => {
    const { floorMap, roomId, breachIdx } = buildFloor({
      breachLeadsToSideArea: false,
      role: RoomRole.NORMAL,
    });

    const results = sealSpecialRooms(floorMap, { roles: [RoomRole.NORMAL] });
    expect(results.has(roomId)).toBe(true);
    expect(floorMap.tileMap.flags[breachIdx]).toBe(TilePresets.WALL);
  });
});
