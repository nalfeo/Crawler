/**
 * Corridor post-processing for the dungeon generator.
 *
 * - `widenCorridors` — widen ~60% of corridor tiles by one perpendicular tile.
 * - `addDiagonalShortcuts` — carve Bresenham diagonal links between nearby rooms.
 * - `carveBresenhamPath` — carve a 2-wide diagonal corridor between two points.
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
 * and not yet directly connected. Uses Bresenham's line algorithm to carve a
 * staircase-style diagonal path. Only wall tiles are overwritten; existing
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
      carveBresenhamPath(tileMap, terrain, cxA, cyA, cxB, cyB, w, h, protectedWalls);
      connected.add(`${Math.min(i, bestJ)}:${Math.max(i, bestJ)}`);
    }
  }
}

/**
 * Carve a Bresenham-line path from (x0,y0) to (x1,y1), converting STONE_WALL
 * tiles to CORRIDOR. Existing floor/door tiles are left unchanged.
 * Each step also widens the path by one tile perpendicular to the major axis
 * so the diagonal corridor is 2 tiles wide and freely navigable.
 */
export function carveBresenhamPath(
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

  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    carve(x, y);
    // Widen by one tile in a fixed perpendicular direction so the corridor is
    // consistently 2 tiles wide regardless of path direction.
    if (dx >= dy) {
      carve(x, y + 1); // horizontal-dominant: always expand south
    } else {
      carve(x + 1, y); // vertical-dominant: always expand east
    }

    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}
