/**
 * FOV System — computes player field-of-view each frame.
 *
 * Uses rot-js RecursiveShadowcasting at **quarter-tile (2×) resolution**.
 * Each tile is divided into a 2×2 grid of sub-tiles; the FOV algorithm runs
 * on this finer grid so the visibility boundary follows shadow edges to
 * within half a tile rather than a full tile.
 *
 * Result is stored on FloorMap's visibility bitmap for O(1) queries
 * by other systems (enemy AI, rendering fog-of-war).
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

  // Convert world position (feet) to quarter-tile coordinates.
  const origin = floorMap.worldToSubTile(px, py);

  // Clear previous visibility
  floorMap.clearVisibility();

  // lightPasses operates in sub-tile space; map back to the underlying tile
  // for the transparency check (walls/floors are still tile-granularity).
  const lightPasses = (hx: number, hy: number): boolean =>
    floorMap.tileMap.isTransparent(hx >> 1, hy >> 1);

  // Compute FOV using recursive shadowcasting at 2× tile resolution.
  // Doubling the radius keeps the effective vision range in feet unchanged.
  const fov = new FOV.RecursiveShadowcasting(lightPasses);

  fov.compute(
    origin.x,
    origin.y,
    DEFAULT_FOV_RADIUS * 2,
    (_hx: number, _hy: number, _r: number, visibility: number) => {
      if (visibility > 0) {
        floorMap.setVisible(_hx, _hy);
      }
    },
  );
}
