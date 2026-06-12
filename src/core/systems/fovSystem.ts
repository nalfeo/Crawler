/**
 * FOV System — computes player field-of-view each frame.
 *
 * Uses rot-js RecursiveShadowcasting against the FloorMap's tile flags.
 * Result is stored on FloorMap's visibility bitmap for O(1) queries
 * by other systems (enemy AI, rendering fog-of-war).
 */

import { FOV } from 'rot-js';
import { query } from 'bitecs';
import { Player, Position } from '../components.js';
import type { GameWorld } from '../world.js';
import type { FloorMap } from '../map/FloorMap.js';

/** Default FOV radius in tiles (~25 tiles ≈ 800px at 32px/tile). */
const DEFAULT_FOV_RADIUS = 25;

interface FovCacheEntry {
  floorMap: FloorMap;
  fov: Shadowcaster;
}

const fovCacheByWorld = new WeakMap<GameWorld, FovCacheEntry>();

interface Shadowcaster {
  compute: (
    x: number,
    y: number,
    radius: number,
    callback: (_x: number, _y: number, _r: number, visibility: number) => void,
  ) => void;
}

function getCachedFov(world: GameWorld, floorMap: FloorMap): Shadowcaster {
  const existing = fovCacheByWorld.get(world);
  if (existing && existing.floorMap === floorMap) {
    return existing.fov;
  }

  const lightPasses = floorMap.tileMap.createLightPassesCallback();
  const fov = new FOV.RecursiveShadowcasting(lightPasses);
  fovCacheByWorld.set(world, { floorMap, fov });
  return fov;
}

export function fovSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) return;

  const playerEid = players[0]!;
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;

  // Convert pixel position to tile coordinates
  const tile = floorMap.pixelToTile(px, py);

  // Clear previous visibility
  floorMap.clearVisibility();

  // Compute FOV using recursive shadowcasting
  const fov = getCachedFov(world, floorMap);

  fov.compute(
    tile.x,
    tile.y,
    DEFAULT_FOV_RADIUS,
    (_x: number, _y: number, _r: number, visibility: number) => {
      if (visibility > 0) {
        floorMap.setVisible(_x, _y);
      }
    },
  );
}
