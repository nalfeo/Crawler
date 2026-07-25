import { describe, it, expect } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { carveSetPieceRoom } from '../../src/core/map/carveSetPieceRoom.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TileFlags,
  TilePresets,
  type MapConfig,
} from '../../src/shared/map-types.js';
import type { SetPieceDef } from '../../src/shared/set-piece-types.js';

const W = 30;
const H = 20;

const CFG: MapConfig = {
  widthTiles: W,
  heightTiles: H,
  tileSizeFt: 32,
  biome: BiomeType.BASIC_UNDERGROUND,
  seed: 1,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 4,
  floorDensity: 0.5,
};

/** A minimal 6×6 prefab def: full wall ring + one door prop on the ring. */
function makeDef(
  overrides: Partial<Pick<SetPieceDef, 'width' | 'height' | 'props' | 'doorSlots'>> = {},
): SetPieceDef {
  const width = overrides.width ?? 6;
  const height = overrides.height ?? 6;
  const props =
    overrides.props ??
    ([
      // one door prop centred on the bottom ring row
      {
        id: 'door-1',
        kind: 'door',
        x: Math.floor(width / 2),
        y: height - 1,
        width: 1,
        height: 1,
        layers: [],
      },
    ] as unknown as SetPieceDef['props']);
  return {
    id: 'test-prefab',
    name: 'Test Prefab',
    width,
    height,
    props,
    npcs: [],
    ...(overrides.doorSlots ? { doorSlots: overrides.doorSlots } : {}),
  } as unknown as SetPieceDef;
}

interface BuiltMap {
  floorMap: FloorMap;
  targetRoomId: number;
}

/**
 * Build a fully-walled map, then carve a spawn room, a target room, and a
 * corridor connecting them. `corridorReachesRing` controls whether the corridor
 * touches the target ring (normal) or stops short of it (grow-into-rock, forces
 * the connector backstop).
 */
function buildMap(opts: { corridorReachesRing?: boolean } = {}): BuiltMap {
  const corridorReachesRing = opts.corridorReachesRing ?? true;
  const flags = new Uint8Array(W * H); // all walls (0)
  const terrain = new Uint8Array(W * H).fill(TerrainType.STONE_WALL);
  const setFloor = (x: number, y: number): void => {
    const idx = y * W + x;
    flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.STONE_FLOOR;
  };

  // Spawn room interior tiles (2..4, 2..4).
  for (let y = 2; y <= 4; y += 1) for (let x = 2; x <= 4; x += 1) setFloor(x, y);

  // Target room bounds {x:10,y:2,width:6,height:6}; interior (11..14, 3..6).
  const targetBounds = { x: 10, y: 2, width: 6, height: 6 };
  for (let y = 3; y <= 6; y += 1) for (let x = 11; x <= 14; x += 1) setFloor(x, y);

  // Corridor along y=3. Reaches the ring at x=10 when corridorReachesRing.
  const corridorEnd = corridorReachesRing ? 10 : 8;
  for (let x = 5; x <= corridorEnd; x += 1) setFloor(x, 3);
  if (corridorReachesRing) {
    // breach the target's left wall so the interior connects pre-carve
    setFloor(10, 3);
  }

  const tileMap = new TileMap(W, H, flags);
  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: 5, height: 5 }, [], [], RoomRole.SPAWN);
  const targetRoomId = graph.add(targetBounds, [], [], RoomRole.SAFE);
  const floorMap = new FloorMap(CFG, tileMap, graph, terrain, { x: 3, y: 3 });
  return { floorMap, targetRoomId };
}

/** Flood from spawn over passable/door tiles; returns reachable mask. */
function reachableFromSpawn(floorMap: FloorMap): Uint8Array {
  const flags = floorMap.tileMap.flags;
  const visited = new Uint8Array(W * H);
  const start = floorMap.playerSpawn.y * W + floorMap.playerSpawn.x;
  const open = (idx: number): boolean =>
    (flags[idx]! & TileFlags.PASSABLE) !== 0 || (flags[idx]! & TileFlags.DOOR) !== 0;
  if (!open(start)) return visited;
  const q = [start];
  visited[start] = 1;
  let head = 0;
  while (head < q.length) {
    const idx = q[head]!;
    head += 1;
    const x = idx % W;
    const y = (idx - x) / W;
    const deltas: readonly (readonly [number, number])[] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dy] of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (visited[n] === 1 || !open(n)) continue;
      visited[n] = 1;
      q.push(n);
    }
  }
  return visited;
}

describe('carveSetPieceRoom', () => {
  it('carves a full impassable wall ring with a real door and reachable interior', () => {
    const { floorMap, targetRoomId } = buildMap();
    const result = carveSetPieceRoom(floorMap, floorMap.roomGraph.get(targetRoomId)!, makeDef());

    expect(result.fitted).toBe(true);
    const b = result.bounds!;
    expect(b.width).toBe(6);
    expect(b.height).toBe(6);

    // Every ring tile is either an impassable wall or a real door.
    let doorCount = 0;
    for (let x = b.x; x < b.x + b.width; x += 1) {
      for (let y = b.y; y < b.y + b.height; y += 1) {
        const onRing =
          x === b.x || x === b.x + b.width - 1 || y === b.y || y === b.y + b.height - 1;
        if (!onRing) continue;
        const f = floorMap.tileMap.flags[y * W + x]!;
        const isDoor = (f & TileFlags.DOOR) !== 0;
        const isWall = (f & TileFlags.PASSABLE) === 0 && !isDoor;
        expect(isDoor || isWall).toBe(true);
        if (isDoor) doorCount += 1;
      }
    }
    expect(doorCount).toBeGreaterThanOrEqual(1);

    // Interior is floor and reachable from spawn.
    const reach = reachableFromSpawn(floorMap);
    const cx = b.x + Math.floor(b.width / 2);
    const cy = b.y + Math.floor(b.height / 2);
    expect(floorMap.tileMap.isPassable(cx, cy)).toBe(true);
    expect(reach[cy * W + cx]).toBe(1);

    // Every door on the room is reachable.
    for (const door of result.doors!) {
      expect(reach[door.y * W + door.x]).toBe(1);
    }
  });

  it('carves a connector when the footprint grows away from every corridor', () => {
    const { floorMap, targetRoomId } = buildMap({ corridorReachesRing: false });
    const result = carveSetPieceRoom(floorMap, floorMap.roomGraph.get(targetRoomId)!, makeDef());
    expect(result.fitted).toBe(true);

    const reach = reachableFromSpawn(floorMap);
    const b = result.bounds!;
    const cx = b.x + Math.floor(b.width / 2);
    const cy = b.y + Math.floor(b.height / 2);
    // The backstop connector must make the interior reachable from spawn.
    expect(reach[cy * W + cx]).toBe(1);
  });

  it('is deterministic — identical inputs produce identical tile writes', () => {
    const a = buildMap();
    const b = buildMap();
    carveSetPieceRoom(a.floorMap, a.floorMap.roomGraph.get(a.targetRoomId)!, makeDef());
    carveSetPieceRoom(b.floorMap, b.floorMap.roomGraph.get(b.targetRoomId)!, makeDef());
    expect(Array.from(a.floorMap.tileMap.flags)).toEqual(Array.from(b.floorMap.tileMap.flags));
    expect(Array.from(a.floorMap.terrain)).toEqual(Array.from(b.floorMap.terrain));
  });

  it('rejects (fitted:false) and mutates nothing when the footprint exceeds the map', () => {
    const { floorMap, targetRoomId } = buildMap();
    const flagsBefore = Array.from(floorMap.tileMap.flags);
    const result = carveSetPieceRoom(
      floorMap,
      floorMap.roomGraph.get(targetRoomId)!,
      makeDef({ width: W + 5, height: 6 }),
    );
    expect(result.fitted).toBe(false);
    expect(result.reason).toContain('footprint');
    expect(Array.from(floorMap.tileMap.flags)).toEqual(flagsBefore);
  });

  it('rejects (fitted:false) when the footprint would overlap another room', () => {
    const { floorMap, targetRoomId } = buildMap();
    // Add a neighbour room whose bounds sit right on top of the centred footprint.
    floorMap.roomGraph.add({ x: 9, y: 1, width: 8, height: 8 }, [], [], RoomRole.NORMAL);
    const flagsBefore = Array.from(floorMap.tileMap.flags);
    const result = carveSetPieceRoom(floorMap, floorMap.roomGraph.get(targetRoomId)!, makeDef());
    expect(result.fitted).toBe(false);
    expect(result.reason).toContain('overlaps-room');
    expect(Array.from(floorMap.tileMap.flags)).toEqual(flagsBefore);
  });

  it('relocates a dynamic door toward the corridor-facing edge', () => {
    const { floorMap, targetRoomId } = buildMap();
    // Door prop authored on the bottom edge, but marked dynamic across all edges.
    const def = makeDef({
      doorSlots: [{ propId: 'door-1', mode: 'dynamic', edges: ['top', 'bottom', 'left', 'right'] }],
    });
    const result = carveSetPieceRoom(floorMap, floorMap.roomGraph.get(targetRoomId)!, def);
    expect(result.fitted).toBe(true);
    // The corridor enters on the LEFT edge (x = bounds.x, y = 3), so the dynamic
    // resolver should place a door on the left column at y=3.
    const b = result.bounds!;
    const leftDoor = result.doors!.find((d) => d.x === b.x && d.y === 3);
    expect(leftDoor).toBeDefined();
  });
});
