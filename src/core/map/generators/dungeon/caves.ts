/**
 * Cave-region carving for the dungeon generator.
 *
 * Opt-in (`caveRegions: true`) post-processing that carves organic cave
 * sub-regions with curved tunnels inside an otherwise rectilinear dungeon,
 * while protecting SAFE/BOSS_STAIR rooms.
 *
 * Extracted from DungeonGenerator.ts (behavior-preserving split).
 */

import { TileFlags, TerrainType, RoomRole } from '../../../../shared/map-types';
import { SeededRandom } from '../../../../shared/random';
import { TileMap } from '../../TileMap';
import { RoomGraph } from '../../RoomGraph';

const CAVE_REGION_DENSITY_DIVISOR = 5000;
const CAVE_PATCH_JITTER_FACTOR = 0.35;

/**
 * Build a mask covering SAFE/BOSS_STAIR rooms (plus a 1-tile margin) so that
 * cave carving never breaches a special room or its surrounding walls.
 */
export function buildCaveProtectedMask(roomGraph: RoomGraph, w: number, h: number): Uint8Array {
  const blocked = new Uint8Array(w * h);
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;
    for (let ty = Math.max(0, y - 1); ty < Math.min(h, y + height + 1); ty++) {
      for (let tx = Math.max(0, x - 1); tx < Math.min(w, x + width + 1); tx++) {
        blocked[ty * w + tx] = 1;
      }
    }
  }
  return blocked;
}

export function carveCaveRegions(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  blocked: Uint8Array,
  seed: number,
): void {
  // Use a deterministic cave-only RNG stream derived from map seed + dimensions.
  // This keeps cave shaping stable across runs while isolating it from the main
  // dungeon RNG progression used by room/corridor generation.
  const caveRng = new SeededRandom(seed ^ 0x9e3779b9 ^ (w << 8) ^ h);
  const caveRand = (): number => caveRng.next();
  const caveRandInt = (min: number, max: number): number => caveRng.nextInt(min, max);

  const candidates: number[] = [];
  const inBounds = (x: number, y: number): boolean => x > 1 && x < w - 2 && y > 1 && y < h - 2;

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const idx = y * w + x;
      if (blocked[idx]) continue;
      if ((tileMap.flags[idx]! & TileFlags.DOOR) !== 0) continue;
      if (terrain[idx] !== TerrainType.STONE_FLOOR) continue;
      const roomId = roomGraph.getRoomAt(x, y);
      if (roomId !== -1) {
        const room = roomGraph.get(roomId);
        if (!room || room.role !== RoomRole.NORMAL) continue;
      }
      candidates.push(idx);
    }
  }

  if (candidates.length === 0) return;

  const regionCount = Math.max(2, Math.min(8, Math.floor((w * h) / CAVE_REGION_DENSITY_DIVISOR)));

  const carveTile = (x: number, y: number): void => {
    if (!inBounds(x, y)) return;
    const idx = y * w + x;
    if (blocked[idx]) return;
    const flags = tileMap.flags[idx]!;
    if ((flags & TileFlags.DOOR) !== 0) return;
    if ((flags & TileFlags.PASSABLE) === 0) return;
    terrain[idx] = TerrainType.CAVE_FLOOR;
  };

  const carveOrganicPatch = (cx: number, cy: number, rx: number, ry: number): void => {
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!inBounds(x, y)) continue;
        const nx = rx <= 0 ? 0 : (x - cx) / rx;
        const ny = ry <= 0 ? 0 : (y - cy) / ry;
        const jitter = (caveRand() - 0.5) * CAVE_PATCH_JITTER_FACTOR;
        if (nx * nx + ny * ny <= 1 + jitter) {
          carveTile(x, y);
        }
      }
    }
  };

  for (let i = 0; i < regionCount; i++) {
    const start = candidates[caveRandInt(0, candidates.length - 1)]!;
    let x = start % w;
    let y = (start - x) / w;
    let angle = caveRand() * Math.PI * 2;
    let curvature = (caveRand() - 0.5) * 0.8;
    const steps = caveRandInt(22, 64);

    for (let step = 0; step < steps; step++) {
      carveOrganicPatch(x, y, caveRandInt(1, 2), caveRandInt(1, 2));

      if (caveRand() < 0.18) {
        carveOrganicPatch(x, y, caveRandInt(3, 6), caveRandInt(2, 5));
      }

      curvature = curvature * 0.72 + (caveRand() - 0.5) * 0.35;
      angle += curvature;
      x = Math.round(x + Math.cos(angle));
      y = Math.round(y + Math.sin(angle));

      if (!inBounds(x, y) || blocked[y * w + x]) {
        angle += Math.PI * (0.6 + caveRand() * 0.8);
        x = Math.min(w - 3, Math.max(2, x));
        y = Math.min(h - 3, Math.max(2, y));
      }
    }
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (terrain[idx] !== TerrainType.CAVE_FLOOR) continue;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        const nIdx = ny * w + nx;
        if (blocked[nIdx]) continue;
        if (terrain[nIdx] === TerrainType.STONE_WALL) {
          terrain[nIdx] = TerrainType.CAVE_WALL;
        }
      }
    }
  }
}
