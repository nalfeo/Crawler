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
  const sf = floorMap.subFactor;

  // Clear previous per-frame visibility (discovered memory persists).
  floorMap.clearVisibility();

  // lightPasses operates in sub-tile space; map back to the underlying tile
  // for the transparency check (walls/floors are still tile-granularity).
  const lightPasses = (hx: number, hy: number): boolean =>
    floorMap.tileMap.isTransparent(Math.floor(hx / sf), Math.floor(hy / sf));

  // Compute FOV using recursive shadowcasting at `subFactor`× tile resolution.
  // Scaling the radius by `subFactor` keeps the vision range in feet unchanged.
  const fov = new FOV.RecursiveShadowcasting(lightPasses);

  fov.compute(
    origin.x,
    origin.y,
    DEFAULT_FOV_RADIUS * sf,
    (_hx: number, _hy: number, _r: number, visibility: number) => {
      if (visibility > 0) {
        floorMap.setVisible(_hx, _hy);
        floorMap.setDiscovered(_hx, _hy);
      }
    },
  );
}
