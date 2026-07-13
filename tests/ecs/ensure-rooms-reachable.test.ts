import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TileMap } from '../../src/core/map/TileMap';
import { RoomGraph } from '../../src/core/map/RoomGraph';
import { ensureRoomsReachable } from '../../src/core/map/generators/DungeonGenerator';
import { ensureBossArenaInterior } from '../../src/core/map/generators/dungeon/reachability';
import { TileFlags, TilePresets, TerrainType, RoomRole } from '../../src/shared/map-types';
import { makeAllWallMap as makeMap } from '../helpers/map-fixtures';
import type { DoorLocation, RoomBounds } from '../../src/shared/map-types';

/** Carve a room's 1-tile-inset interior to floor. */
function carveRoom(tileMap: TileMap, terrain: Uint8Array, w: number, b: RoomBounds): void {
  for (let ty = b.y + 1; ty < b.y + b.height - 1; ty++) {
    for (let tx = b.x + 1; tx < b.x + b.width - 1; tx++) {
      const idx = ty * w + tx;
      tileMap.flags[idx] = TilePresets.FLOOR;
      terrain[idx] = TerrainType.STONE_FLOOR;
    }
  }
}

/** Carve a straight horizontal corridor (inclusive of both ends). */
function carveCorridorH(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  y: number,
  x0: number,
  x1: number,
): void {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  for (let x = lo; x <= hi; x++) {
    const idx = y * w + x;
    tileMap.flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.CORRIDOR;
  }
}

function setDoor(tileMap: TileMap, w: number, x: number, y: number): void {
  tileMap.flags[y * w + x] = TilePresets.DOOR_CLOSED;
}

/** Flood from a start tile over PASSABLE + DOOR tiles. */
function reachable(tileMap: TileMap, w: number, h: number, sx: number, sy: number): Set<number> {
  const seen = new Set<number>([sy * w + sx]);
  const stack = [sy * w + sx];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (seen.has(nIdx)) continue;
      const flags = tileMap.flags[nIdx]!;
      if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
      seen.add(nIdx);
      stack.push(nIdx);
    }
  }
  return seen;
}

function interiorReachable(
  tileMap: TileMap,
  w: number,
  _h: number,
  b: RoomBounds,
  seen: Set<number>,
): boolean {
  for (let ty = b.y + 1; ty < b.y + b.height - 1; ty++) {
    for (let tx = b.x + 1; tx < b.x + b.width - 1; tx++) {
      const idx = ty * w + tx;
      if ((tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
      if (seen.has(idx)) return true;
    }
  }
  return false;
}

describe('ensureRoomsReachable', () => {
  const W = 24;
  const H = 12;
  const spawn = { x: 3, y: 5 };

  it('carves a connector so an isolated room becomes reachable from spawn', () => {
    const { tileMap, terrain } = makeMap(W, H);
    const spawnBounds: RoomBounds = { x: 1, y: 3, width: 6, height: 6 };
    const isolatedBounds: RoomBounds = { x: 15, y: 3, width: 6, height: 6 };
    carveRoom(tileMap, terrain, W, spawnBounds);
    carveRoom(tileMap, terrain, W, isolatedBounds);
    // Door on the isolated room's left wall, but no corridor leads to it.
    const door: DoorLocation = { x: 15, y: 5, connectsTo: 0 };
    setDoor(tileMap, W, door.x, door.y);

    const graph = new RoomGraph();
    graph.add(spawnBounds, [], [], RoomRole.SPAWN);
    graph.add(isolatedBounds, [door], [], RoomRole.NORMAL);

    expect(
      interiorReachable(tileMap, W, H, isolatedBounds, reachable(tileMap, W, H, spawn.x, spawn.y)),
    ).toBe(false);

    ensureRoomsReachable(tileMap, terrain, graph, W, H, spawn);

    expect(
      interiorReachable(tileMap, W, H, isolatedBounds, reachable(tileMap, W, H, spawn.x, spawn.y)),
    ).toBe(true);
  });

  it('reconnects an isolated boss-stair room (phase 2) via its door', () => {
    const { tileMap, terrain } = makeMap(W, H);
    const spawnBounds: RoomBounds = { x: 1, y: 3, width: 6, height: 6 };
    const bossBounds: RoomBounds = { x: 15, y: 3, width: 6, height: 6 };
    carveRoom(tileMap, terrain, W, spawnBounds);
    carveRoom(tileMap, terrain, W, bossBounds);
    const door: DoorLocation = { x: 15, y: 5, connectsTo: 0 };
    setDoor(tileMap, W, door.x, door.y);

    const graph = new RoomGraph();
    graph.add(spawnBounds, [], [], RoomRole.SPAWN);
    graph.add(bossBounds, [door], [], RoomRole.BOSS_STAIR);

    ensureRoomsReachable(tileMap, terrain, graph, W, H, spawn);

    const seen = reachable(tileMap, W, H, spawn.x, spawn.y);
    expect(interiorReachable(tileMap, W, H, bossBounds, seen)).toBe(true);
    // The door tile itself must remain a door (gating preserved, not carved open).
    expect((tileMap.flags[door.y * W + door.x]! & TileFlags.DOOR) !== 0).toBe(true);
  });

  it('repairs an all-wall boss room with a centered arena and door path', () => {
    const repairW = 32;
    const repairH = 24;
    const { tileMap, terrain } = makeMap(repairW, repairH);
    const spawnBounds: RoomBounds = { x: 1, y: 8, width: 6, height: 6 };
    const bossBounds: RoomBounds = { x: 12, y: 3, width: 17, height: 17 };
    carveRoom(tileMap, terrain, repairW, spawnBounds);
    carveCorridorH(tileMap, terrain, repairW, 10, 5, 28);
    const door: DoorLocation = { x: 28, y: 4, connectsTo: 0 };
    setDoor(tileMap, repairW, door.x, door.y);

    const graph = new RoomGraph();
    graph.add(spawnBounds, [], [], RoomRole.SPAWN);
    graph.add(bossBounds, [door], [], RoomRole.BOSS_STAIR);

    ensureRoomsReachable(tileMap, terrain, graph, repairW, repairH, { x: 3, y: 10 });

    for (let y = 9; y <= 13; y += 1) {
      for (let x = 18; x <= 22; x += 1) {
        expect(tileMap.isPassable(x, y)).toBe(true);
        expect(terrain[y * repairW + x]).toBe(TerrainType.BOSS_STAIR_FLOOR);
      }
    }
    expect(tileMap.isPassable(27, 4)).toBe(true);
    expect(tileMap.isPassable(20, 4)).toBe(true);
    expect(tileMap.isPassable(20, 9)).toBe(true);
    expect((tileMap.flags[door.y * repairW + door.x]! & TileFlags.DOOR) !== 0).toBe(true);
  });

  it('repairs a dynamically declared encounter room using its existing floor terrain', () => {
    const repairW = 32;
    const repairH = 24;
    const { tileMap, terrain } = makeMap(repairW, repairH);
    const roomBounds: RoomBounds = { x: 12, y: 3, width: 17, height: 17 };
    const door: DoorLocation = { x: 28, y: 4, connectsTo: 0 };
    setDoor(tileMap, repairW, door.x, door.y);
    const graph = new RoomGraph();
    const roomId = graph.add(roomBounds, [door], [], RoomRole.NORMAL);

    ensureBossArenaInterior(
      tileMap,
      terrain,
      repairW,
      repairH,
      graph.get(roomId)!,
      TerrainType.STONE_FLOOR,
    );

    for (let y = 9; y <= 13; y += 1) {
      for (let x = 18; x <= 22; x += 1) {
        expect(tileMap.isPassable(x, y)).toBe(true);
        expect(terrain[y * repairW + x]).toBe(TerrainType.STONE_FLOOR);
      }
    }
    expect(tileMap.isPassable(27, 4)).toBe(true);
    expect(tileMap.isPassable(20, 4)).toBe(true);
    expect(tileMap.isPassable(20, 9)).toBe(true);
    expect((tileMap.flags[door.y * repairW + door.x]! & TileFlags.DOOR) !== 0).toBe(true);
  });

  it('is a byte-identical no-op for a connected L-shaped encounter room', () => {
    const repairW = 24;
    const repairH = 20;
    const { tileMap, terrain } = makeMap(repairW, repairH);
    const roomBounds: RoomBounds = { x: 4, y: 3, width: 16, height: 14 };
    carveRoom(tileMap, terrain, repairW, roomBounds);
    const door: DoorLocation = { x: 4, y: 12, connectsTo: 0 };
    setDoor(tileMap, repairW, door.x, door.y);
    for (let ty = 4; ty < 10; ty += 1) {
      for (let tx = 5; tx < 12; tx += 1) {
        tileMap.flags[ty * repairW + tx] = TilePresets.WALL;
        terrain[ty * repairW + tx] = TerrainType.STONE_WALL;
      }
    }
    const graph = new RoomGraph();
    const roomId = graph.add(roomBounds, [door], [], RoomRole.NORMAL);
    const flagsBefore = Uint8Array.from(tileMap.flags);
    const terrainBefore = Uint8Array.from(terrain);

    ensureBossArenaInterior(
      tileMap,
      terrain,
      repairW,
      repairH,
      graph.get(roomId)!,
      TerrainType.STONE_FLOOR,
    );

    expect(tileMap.flags).toEqual(flagsBefore);
    expect(terrain).toEqual(terrainBefore);
  });

  it('is a byte-identical no-op for valid connected boss arenas across room sizes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 21 }),
        fc.integer({ min: 7, max: 21 }),
        (bossWidth, bossHeight) => {
          const mapWidth = bossWidth + 14;
          const mapHeight = bossHeight + 6;
          const { tileMap, terrain } = makeMap(mapWidth, mapHeight);
          const spawnBounds: RoomBounds = { x: 1, y: 2, width: 6, height: 6 };
          const bossBounds: RoomBounds = {
            x: 10,
            y: 2,
            width: bossWidth,
            height: bossHeight,
          };
          carveRoom(tileMap, terrain, mapWidth, spawnBounds);
          carveRoom(tileMap, terrain, mapWidth, bossBounds);
          for (let y = bossBounds.y + 1; y < bossBounds.y + bossBounds.height - 1; y += 1) {
            for (let x = bossBounds.x + 1; x < bossBounds.x + bossBounds.width - 1; x += 1) {
              terrain[y * mapWidth + x] = TerrainType.BOSS_STAIR_FLOOR;
            }
          }
          const door: DoorLocation = {
            x: bossBounds.x,
            y: bossBounds.y + 1,
            connectsTo: 0,
          };
          setDoor(tileMap, mapWidth, door.x, door.y);
          carveCorridorH(tileMap, terrain, mapWidth, door.y, 5, door.x - 1);

          const graph = new RoomGraph();
          graph.add(spawnBounds, [], [], RoomRole.SPAWN);
          graph.add(bossBounds, [door], [], RoomRole.BOSS_STAIR);
          const flagsBefore = Uint8Array.from(tileMap.flags);
          const terrainBefore = Uint8Array.from(terrain);

          ensureRoomsReachable(tileMap, terrain, graph, mapWidth, mapHeight, {
            x: 3,
            y: door.y,
          });

          expect(tileMap.flags).toEqual(flagsBefore);
          expect(terrain).toEqual(terrainBefore);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('is a strict no-op when every room is already reachable', () => {
    const { tileMap, terrain } = makeMap(W, H);
    const spawnBounds: RoomBounds = { x: 1, y: 3, width: 6, height: 6 };
    const otherBounds: RoomBounds = { x: 15, y: 3, width: 6, height: 6 };
    carveRoom(tileMap, terrain, W, spawnBounds);
    carveRoom(tileMap, terrain, W, otherBounds);
    const door: DoorLocation = { x: 15, y: 5, connectsTo: 0 };
    setDoor(tileMap, W, door.x, door.y);
    // Open corridor from spawn interior to the door so the room is connected.
    carveCorridorH(tileMap, terrain, W, 5, 5, 14);

    const graph = new RoomGraph();
    graph.add(spawnBounds, [], [], RoomRole.SPAWN);
    graph.add(otherBounds, [door], [], RoomRole.NORMAL);

    const flagsBefore = Uint8Array.from(tileMap.flags);
    const terrainBefore = Uint8Array.from(terrain);

    ensureRoomsReachable(tileMap, terrain, graph, W, H, spawn);

    expect(tileMap.flags).toEqual(flagsBefore);
    expect(terrain).toEqual(terrainBefore);
  });

  it('routes a truly-isolated room around the locked boss room (no boss dependency)', () => {
    // Topology: spawn (left), a wide boss room (centre), and a sealed gate room
    // (right). Nothing is corridor-linked, so the gate is TRULY isolated. The boss
    // room blocks the straight-line route, so the only way to reach the gate is to
    // detour around the boss. The fix must carve such a detour WITHOUT tunnelling
    // through the boss room (its lock must keep gating entry).
    const { tileMap, terrain } = makeMap(W, H);
    const spawnBounds: RoomBounds = { x: 1, y: 3, width: 6, height: 6 };
    const bossBounds: RoomBounds = { x: 9, y: 4, width: 6, height: 4 };
    const gateBounds: RoomBounds = { x: 17, y: 3, width: 6, height: 6 };
    carveRoom(tileMap, terrain, W, spawnBounds);
    carveRoom(tileMap, terrain, W, bossBounds);
    carveRoom(tileMap, terrain, W, gateBounds);
    const bossDoor: DoorLocation = { x: 9, y: 5, connectsTo: 0 };
    setDoor(tileMap, W, bossDoor.x, bossDoor.y);
    const gateDoor: DoorLocation = { x: 17, y: 5, connectsTo: 0 };
    setDoor(tileMap, W, gateDoor.x, gateDoor.y);

    const graph = new RoomGraph();
    graph.add(spawnBounds, [], [], RoomRole.SPAWN);
    graph.add(bossBounds, [bossDoor], [], RoomRole.BOSS_STAIR);
    graph.add(gateBounds, [gateDoor], [], RoomRole.NORMAL);

    // Pre-fix: the gate is unreachable even with every door treated as open.
    expect(
      interiorReachable(tileMap, W, H, gateBounds, reachable(tileMap, W, H, spawn.x, spawn.y)),
    ).toBe(false);

    ensureRoomsReachable(tileMap, terrain, graph, W, H, spawn);

    // Flood that treats the boss room (bounds + its door) as impassable — proves the
    // gate's carved connector does not depend on passing through the boss room.
    const blockedBoss = (idx: number): boolean => {
      const x = idx % W;
      const y = (idx - x) / W;
      const inBounds =
        x >= bossBounds.x &&
        x < bossBounds.x + bossBounds.width &&
        y >= bossBounds.y &&
        y < bossBounds.y + bossBounds.height;
      return inBounds || (x === bossDoor.x && y === bossDoor.y);
    };
    const seen = new Set<number>([spawn.y * W + spawn.x]);
    const stack = [spawn.y * W + spawn.x];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const cx = idx % W;
      const cy = (idx - cx) / W;
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ] as [number, number][]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nIdx = ny * W + nx;
        if (seen.has(nIdx) || blockedBoss(nIdx)) continue;
        const flags = tileMap.flags[nIdx]!;
        if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
        seen.add(nIdx);
        stack.push(nIdx);
      }
    }
    expect(interiorReachable(tileMap, W, H, gateBounds, seen)).toBe(true);
  });

  it('is deterministic (identical output across runs)', () => {
    const build = (): { tileMap: TileMap; terrain: Uint8Array; graph: RoomGraph } => {
      const { tileMap, terrain } = makeMap(W, H);
      const spawnBounds: RoomBounds = { x: 1, y: 3, width: 6, height: 6 };
      const isoBounds: RoomBounds = { x: 15, y: 3, width: 6, height: 6 };
      carveRoom(tileMap, terrain, W, spawnBounds);
      carveRoom(tileMap, terrain, W, isoBounds);
      const door: DoorLocation = { x: 15, y: 5, connectsTo: 0 };
      setDoor(tileMap, W, door.x, door.y);
      const graph = new RoomGraph();
      graph.add(spawnBounds, [], [], RoomRole.SPAWN);
      graph.add(isoBounds, [door], [], RoomRole.NORMAL);
      return { tileMap, terrain, graph };
    };

    const a = build();
    const b = build();
    ensureRoomsReachable(a.tileMap, a.terrain, a.graph, W, H, spawn);
    ensureRoomsReachable(b.tileMap, b.terrain, b.graph, W, H, spawn);
    expect(a.tileMap.flags).toEqual(b.tileMap.flags);
    expect(a.terrain).toEqual(b.terrain);
  });
});
