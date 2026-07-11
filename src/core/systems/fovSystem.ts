/**
 * FOV System — computes player field-of-view each frame.
 *
 * Uses rot-js RecursiveShadowcasting at **dynamic sub-tile resolution**.
 * Each tile is divided into a `subFactor`×`subFactor` grid (default 2×, i.e.
 * quarter-tile); the FOV algorithm runs on this finer grid so the visibility
 * boundary follows shadow edges to within `1/subFactor` of a tile. The factor
 * is runtime-configurable via `FloorMap.setSubFactor` (lab-tunable).
 *
 * Results are stored on FloorMap's `visible` (per-frame) and `discovered`
 * (persistent) bitmaps for O(1) tile-level queries by other systems (enemy AI,
 * rendering fog-of-war, discovered-terrain dimming).
 */

import { FOV } from 'rot-js';
import { query } from 'bitecs';
import { Player, Position } from '../components.js';
import type { GameWorld } from '../world.js';

/** Default FOV radius in tiles (~25 tiles ≈ 100ft at 4ft/tile). */
const DEFAULT_FOV_RADIUS = 25;

interface FovCacheKey {
  originX: number;
  originY: number;
  subFactor: number;
  transparencyRevision: number;
}

const fovCacheByMap = new WeakMap<GameWorld['floorMap'] & object, FovCacheKey>();

export function fovSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) return;

  const playerEid = players[0]!;
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;

  // Convert world position (feet) to sub-tile coordinates.
  const origin = floorMap.worldToSubTile(px, py);
  const originTile = floorMap.worldToTile(px, py);
  const sf = floorMap.subFactor;
  const transparencyRevision = floorMap.tileMap.transparencyRevision;
  const cached = fovCacheByMap.get(floorMap);
  if (
    cached?.originX === origin.x &&
    cached.originY === origin.y &&
    cached.subFactor === sf &&
    cached.transparencyRevision === transparencyRevision
  ) {
    return;
  }

  // Clear previous per-frame visibility (discovered memory persists).
  floorMap.clearVisibility();

  // lightPasses operates in sub-tile space; map back to the underlying tile
  // for the transparency check (walls/floors are still tile-granularity).
  const lightPasses = (hx: number, hy: number): boolean =>
    floorMap.tileMap.isTransparent(Math.floor(hx / sf), Math.floor(hy / sf));

  // Compute FOV using recursive shadowcasting at `subFactor`× tile resolution.
  // Scaling the radius by `subFactor` keeps the vision range in feet unchanged.
  const fov = new FOV.RecursiveShadowcasting(lightPasses);

  // Cache seam-blocked results per tile coordinate for this FOV pass.
  // Multiple sub-tiles map to the same (tx,ty); without the cache each sub-tile
  // would walk the full ray, making the per-frame cost O(sub-tiles × ray-length).
  const seamCache = new Map<number, boolean>();
  const mapWidth = floorMap.tileMap.width;

  fov.compute(
    origin.x,
    origin.y,
    DEFAULT_FOV_RADIUS * sf,
    (hx: number, hy: number, _r: number, visibility: number) => {
      if (visibility > 0) {
        const tx = Math.floor(hx / sf);
        const ty = Math.floor(hy / sf);
        // Apply corner-seam blocking across the entire ray from origin to candidate,
        // matching the consistency rules enforced by lineOfSight. This ensures FOV
        // and LOS agree: if lineOfSight rejects a candidate due to a blocked corner
        // seam, FOV will also reject it. Result is cached per tile to avoid
        // re-walking the ray for every sub-tile that maps to the same tile coord.
        const cacheKey = ty * mapWidth + tx;
        let seamBlocked = seamCache.get(cacheKey);
        if (seamBlocked === undefined) {
          seamBlocked = floorMap.tileMap.hasBlockedCornerSeam(originTile.x, originTile.y, tx, ty);
          seamCache.set(cacheKey, seamBlocked);
        }
        if (seamBlocked) {
          return;
        }
        floorMap.setVisible(hx, hy);
        floorMap.setDiscovered(hx, hy);
      }
    },
  );
  fovCacheByMap.set(floorMap, {
    originX: origin.x,
    originY: origin.y,
    subFactor: sf,
    transparencyRevision,
  });
}
