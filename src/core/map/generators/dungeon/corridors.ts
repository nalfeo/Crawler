/**
 * Corridor post-processing for the dungeon generator.
 *
 * - `widenCorridors` — widen ~60% of corridor tiles by one perpendicular tile.
 * - `addDiagonalShortcuts` — carve centerline/tube diagonal links between nearby rooms.
 * - `carveTubePath` — carve a capsule-shaped diagonal corridor between two points.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split).
 */

import { TilePresets, TerrainType } from '../../../../shared/map-types';
import { SeededRandom } from '../../../../shared/random';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';

/**
 * Widen corridors by one tile perpendicular to their primary direction.
 * Horizontal corridors (neighboured E/W by floor) get a north or south tile added;
 * vertical corridors get an east or west tile added. Uses a two-pass approach
 * to avoid cascading widening from a single pass.
 * ~60% of corridor tiles are widened to preserve some narrow sections.
 */
export function widenCorridors(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  rng: SeededRandom,
  protectedWalls: ReadonlySet<number>,
): ReadonlySet<number> {
  const toWiden = new Set<number>();

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (terrain[idx] !== TerrainType.CORRIDOR) continue;
      if (rng.next() > 0.6) continue; // only widen ~60% of corridor tiles

      const tN = terrain[(y - 1) * w + x]!;
      const tS = terrain[(y + 1) * w + x]!;
      const tE = terrain[y * w + (x + 1)]!;
      const tW = terrain[y * w + (x - 1)]!;

      const floorOrCorridor = (t: number): boolean =>
        t === TerrainType.CORRIDOR ||
        t === TerrainType.STONE_FLOOR ||
        t === TerrainType.DOOR ||
        t === TerrainType.SAFE_ROOM_FLOOR ||
        t === TerrainType.BOSS_STAIR_FLOOR;

      const hasNS = floorOrCorridor(tN) || floorOrCorridor(tS);
      const hasEW = floorOrCorridor(tE) || floorOrCorridor(tW);

      if (hasNS && !hasEW) {
        // Vertical corridor — try to expand east
        const targetIdx = y * w + (x + 1);
        if (
          x + 1 < w - 1 &&
          terrain[targetIdx] === TerrainType.STONE_WALL &&
          !protectedWalls.has(targetIdx)
        ) {
          toWiden.add(targetIdx);
        }
      } else if (hasEW && !hasNS) {
        // Horizontal corridor — try to expand south
        const targetIdx = (y + 1) * w + x;
        if (
          y + 1 < h - 1 &&
          terrain[targetIdx] === TerrainType.STONE_WALL &&
          !protectedWalls.has(targetIdx)
        ) {
          toWiden.add(targetIdx);
        }
      }
    }
  }

  for (const idx of toWiden) {
    terrain[idx] = TerrainType.CORRIDOR;
    tileMap.flags[idx] = TilePresets.FLOOR;
  }
  return toWiden;
}

/**
 * Add diagonal shortcut corridors between rooms that are positioned diagonally
 * and not yet directly connected. Uses a centerline + tube brush to carve a
 * smoother diagonal path. Only wall tiles are overwritten; existing
 * floor/corridor/door tiles are preserved.
 */
export function addDiagonalShortcuts(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  rng: SeededRandom,
  protectedWalls: ReadonlySet<number>,
): void {
  const rooms = roomGraph.getAll();
  const connected = new Set<string>();

  for (let i = 0; i < rooms.length; i++) {
    if (rng.next() >= 0.7) continue; // attempt a diagonal shortcut for ~30% of rooms

    const a = rooms[i]!;
    const cxA = Math.floor(a.bounds.x + a.bounds.width / 2);
    const cyA = Math.floor(a.bounds.y + a.bounds.height / 2);

    let bestDist = Infinity;
    let bestJ = -1;

    for (let j = 0; j < rooms.length; j++) {
      if (j === i) continue;
      const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
      if (connected.has(key)) continue;

      const b = rooms[j]!;
      const cxB = Math.floor(b.bounds.x + b.bounds.width / 2);
      const cyB = Math.floor(b.bounds.y + b.bounds.height / 2);
      const dx = Math.abs(cxB - cxA);
      const dy = Math.abs(cyB - cyA);

      // Both components must be significant (truly diagonal)
      if (dx < 8 || dy < 8) continue;
      // Not too far to be a useful shortcut
      const dist = dx + dy; // Manhattan, fast
      if (dist > 60) continue;
      // Diagonal ratio: neither axis should dominate more than ~3:1
      if (dx > dy * 3 || dy > dx * 3) continue;

      if (dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }

    if (bestJ >= 0) {
      const b = rooms[bestJ]!;
      const cxB = Math.floor(b.bounds.x + b.bounds.width / 2);
      const cyB = Math.floor(b.bounds.y + b.bounds.height / 2);
      carveTubePath(tileMap, terrain, cxA, cyA, cxB, cyB, w, h, protectedWalls);
      connected.add(`${Math.min(i, bestJ)}:${Math.max(i, bestJ)}`);
    }
  }
}

/**
 * Carve a line-tube path from (x0,y0) to (x1,y1), converting STONE_WALL tiles
 * to CORRIDOR. Existing floor/door tiles are left unchanged.
 * The brush is a deterministic capsule around the line segment, so diagonal
 * corridors no longer staircase as harshly as a Bresenham walk.
 */
function carveTubePath(
  tileMap: TileMap,
  terrain: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
  protectedWalls: ReadonlySet<number>,
): void {
  const carve = (x: number, y: number): void => {
    if (x <= 0 || x >= w - 1 || y <= 0 || y >= h - 1) return;
    const idx = y * w + x;
    if (protectedWalls.has(idx)) return; // never breach special room perimeters
    if (terrain[idx] === TerrainType.STONE_WALL) {
      terrain[idx] = TerrainType.CORRIDOR;
      tileMap.flags[idx] = TilePresets.FLOOR;
    }
  };

  const ax = x0 + 0.5;
  const ay = y0 + 0.5;
  const bx = x1 + 0.5;
  const by = y1 + 0.5;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const radius = 0.95;

  const pointToSegmentDistance = (px: number, py: number): number => {
    if (lenSq <= 0.0001) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projX = ax + dx * t;
    const projY = ay + dy * t;
    return Math.hypot(px - projX, py - projY);
  };

  const minX = Math.max(1, Math.floor(Math.min(ax, bx) - radius - 1));
  const maxX = Math.min(w - 2, Math.ceil(Math.max(ax, bx) + radius + 1));
  const minY = Math.max(1, Math.floor(Math.min(ay, by) - radius - 1));
  const maxY = Math.min(h - 2, Math.ceil(Math.max(ay, by) + radius + 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance = pointToSegmentDistance(x + 0.5, y + 0.5);
      if (distance <= radius) carve(x, y);
    }
  }

  const toFill: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * w + x;
      if (protectedWalls.has(idx) || terrain[idx] !== TerrainType.STONE_WALL) continue;
      let passableNeighbors = 0;
      for (let dy2 = -1; dy2 <= 1; dy2++) {
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          if (dx2 === 0 && dy2 === 0) continue;
          const nx = x + dx2;
          const ny = y + dy2;
          const neighbor = terrain[ny * w + nx];
          if (
            neighbor === TerrainType.CORRIDOR ||
            neighbor === TerrainType.STONE_FLOOR ||
            neighbor === TerrainType.DOOR ||
            neighbor === TerrainType.SAFE_ROOM_FLOOR ||
            neighbor === TerrainType.BOSS_STAIR_FLOOR
          ) {
            passableNeighbors++;
          }
        }
      }
      if (passableNeighbors >= 5 && pointToSegmentDistance(x + 0.5, y + 0.5) <= radius + 0.6) {
        toFill.push(idx);
      }
    }
  }

  for (const idx of toFill) {
    terrain[idx] = TerrainType.CORRIDOR;
    tileMap.flags[idx] = TilePresets.FLOOR;
  }
}
