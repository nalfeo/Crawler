/**
 * Prop Placer — scatter ambient scene-dressing props across a generated floor.
 *
 * Placement is driven by each DecorationDef's `PlacementZone`, resolved against
 * `floorMap.terrain` so props respect sub-region types (cave patches, corridors,
 * room interiors). A `SeededRandom` instance ensures determinism.
 *
 * Only defs that match the provided `biomeTag` AND appear in `allowedCategories`
 * are considered. Density is expressed as count-per-1000-sq-ft and scaled by a
 * per-floor multiplier from the floor manifest.
 */

import { TerrainType, RoomRole } from '../../shared/map-types.js';
import type { BiomeTag } from '../../shared/biome-tags.js';
import type { PlacementZone, PropCategory } from '../../shared/decorationDefs.js';
import { DECORATION_DEFS } from '../../shared/decorationDefs.js';
import { spawnProp } from '../../core/helpers.js';
import type { GameWorld } from '../../core/world.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import type { SeededRandom } from '../../shared/random.js';

/** Configuration passed from a floor manifest's `props` section. */
export interface PropPlacerConfig {
  biomeTag: BiomeTag;
  densityMultiplier?: number;
  allowedCategories?: PropCategory[];
}

/**
 * Candidate tile info produced by zone resolution.
 */
interface Candidate {
  tx: number;
  ty: number;
}

/** Wall terrain types used for wall-adjacent candidate detection. */
const WALL_TYPES = new Set<number>([TerrainType.STONE_WALL, TerrainType.CAVE_WALL]);

/** Passable terrain types (floor tiles that actors can stand on). */
const PASSABLE_TERRAIN = new Set<number>([
  TerrainType.STONE_FLOOR,
  TerrainType.CAVE_FLOOR,
  TerrainType.CORRIDOR,
  TerrainType.BOSS_STAIR_FLOOR,
  TerrainType.SAFE_ROOM_FLOOR,
  TerrainType.WOOD_FLOOR,
  TerrainType.GRASS,
  TerrainType.DIRT,
]);

/** Special room roles excluded from 'anywhere' placement. */
const SPECIAL_ROLES = new Set([RoomRole.SPAWN, RoomRole.SAFE, RoomRole.BOSS_STAIR]);

/**
 * Build a Set of tile indices belonging to special rooms (SPAWN / SAFE / BOSS_STAIR).
 * Props with placementZone 'anywhere' skip these tiles.
 */
export function buildSpecialRoomMask(floorMap: FloorMap): Set<number> {
  const mask = new Set<number>();
  const w = floorMap.width;
  for (const room of floorMap.rooms) {
    if (!SPECIAL_ROLES.has(room.role)) continue;
    const { x, y, width, height } = room.bounds;
    for (let ty = y; ty < y + height; ty++) {
      for (let tx = x; tx < x + width; tx++) {
        mask.add(ty * w + tx);
      }
    }
  }
  return mask;
}

/**
 * Build a Set of tile indices inside NORMAL rooms.
 * Used for 'room-only' placement.
 */
export function buildNormalRoomMask(floorMap: FloorMap): Set<number> {
  const mask = new Set<number>();
  const w = floorMap.width;
  for (const room of floorMap.rooms) {
    if (room.role !== RoomRole.NORMAL) continue;
    const { x, y, width, height } = room.bounds;
    for (let ty = y; ty < y + height; ty++) {
      for (let tx = x; tx < x + width; tx++) {
        mask.add(ty * w + tx);
      }
    }
  }
  return mask;
}

/**
 * Check whether tile (tx, ty) has at least one orthogonally adjacent wall.
 */
function hasAdjacentWall(
  terrain: Uint8Array,
  w: number,
  h: number,
  tx: number,
  ty: number,
): boolean {
  const dirs = [
    [tx - 1, ty],
    [tx + 1, ty],
    [tx, ty - 1],
    [tx, ty + 1],
  ];
  for (const [nx, ny] of dirs) {
    if (nx === undefined || ny === undefined) continue;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const t = terrain[ny * w + nx];
    if (t !== undefined && WALL_TYPES.has(t)) return true;
  }
  return false;
}

/**
 * Collect all candidate tiles for the given placement zone.
 */
export function resolveCandidates(
  floorMap: FloorMap,
  zone: PlacementZone,
  specialMask: Set<number>,
  normalRoomMask: Set<number>,
): Candidate[] {
  const { terrain, width: w, height: h } = floorMap;
  const candidates: Candidate[] = [];

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const idx = ty * w + tx;
      const t = terrain[idx];
      if (t === undefined || !PASSABLE_TERRAIN.has(t)) continue;

      switch (zone) {
        case 'cave-only':
          if (t === TerrainType.CAVE_FLOOR) candidates.push({ tx, ty });
          break;
        case 'corridor-only':
          if (t === TerrainType.CORRIDOR) candidates.push({ tx, ty });
          break;
        case 'room-only':
          if (normalRoomMask.has(idx)) candidates.push({ tx, ty });
          break;
        case 'wall-adjacent':
          if (!specialMask.has(idx) && hasAdjacentWall(terrain, w, h, tx, ty))
            candidates.push({ tx, ty });
          break;
        case 'anywhere':
        default:
          if (!specialMask.has(idx)) candidates.push({ tx, ty });
          break;
      }
    }
  }
  return candidates;
}

/**
 * Place props for a floor, deterministically, using the provided RNG.
 *
 * @returns An array of spawned entity IDs.
 */
export function placePropsForFloor(
  world: GameWorld,
  floorMap: FloorMap,
  config: PropPlacerConfig,
  rng: SeededRandom,
): number[] {
  const { biomeTag, densityMultiplier = 1.0, allowedCategories } = config;
  const tileSizeFt = floorMap.config.tileSizeFt;
  const tileAreaSqFt = tileSizeFt * tileSizeFt;

  const specialMask = buildSpecialRoomMask(floorMap);
  const normalRoomMask = buildNormalRoomMask(floorMap);

  const spawnedEids: number[] = [];

  for (const decorationDef of DECORATION_DEFS.values()) {
    if (decorationDef.biomeTag !== biomeTag) continue;
    if (allowedCategories !== undefined && !allowedCategories.includes(decorationDef.category)) {
      continue;
    }

    const candidates = resolveCandidates(
      floorMap,
      decorationDef.placementZone,
      specialMask,
      normalRoomMask,
    );
    if (candidates.length === 0) continue;

    // Density is count per 1000 sq-ft of candidate area.
    const candidateAreaSqFt = candidates.length * tileAreaSqFt;
    const targetCount = Math.round(
      (candidateAreaSqFt / 1000) * decorationDef.density * densityMultiplier,
    );
    if (targetCount <= 0) continue;

    // Fisher-Yates shuffle the first targetCount elements.
    const pool = candidates.slice();
    const pick = Math.min(targetCount, pool.length);
    for (let i = 0; i < pick; i++) {
      const j = i + Math.floor(rng.next() * (pool.length - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }

    for (let i = 0; i < pick; i++) {
      const { tx, ty } = pool[i]!;
      // Place at tile centre with ±0.3 ft jitter.
      const jitterX = (rng.next() - 0.5) * 0.6;
      const jitterY = (rng.next() - 0.5) * 0.6;
      const wx = (tx + 0.5) * tileSizeFt + jitterX;
      const wy = (ty + 0.5) * tileSizeFt + jitterY;
      const eid = spawnProp(world, wx, wy, decorationDef.id);
      if (eid >= 0) spawnedEids.push(eid);
    }
  }

  return spawnedEids;
}
