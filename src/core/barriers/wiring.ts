/**
 * Barrier wiring — install the barrier lookup on a FloorMap.
 *
 * `FloorMap.isPassableAt` consults an optional predicate for barrier
 * membership. This wiring helper connects it to the world's barrier
 * registry so movement/projectile/pathfinding chokepoints see live
 * barriers automatically, without having to plumb `world` through every
 * physics call.
 *
 * Call this every time a fresh `FloorMap` is assigned to `world.floorMap`:
 * once at floor load, and again after any hot-reload. It is safe to call
 * repeatedly — installing the same lookup twice is a no-op at the physics
 * level.
 */
import type { BarrierWorld } from './registry.js';
import { isBarrierPointBlocked, isBarrierTile } from './registry.js';

/**
 * Install a barrier-membership predicate on `world.floorMap` (no-op when
 * there is no floor map). Reads through the world reference each call so
 * the lookup remains live as barriers come and go.
 *
 * `world` is also handed to the floor map as a **presence source**. Both
 * predicates below answer purely from `world.barriers.blockedTiles` /
 * `world.barriers.ringShapes`, so when the matching collection is empty the
 * answer is `false` by construction and `FloorMap` skips the call outright.
 * That is the whole point: on a Floor-1 run these two closures are invoked
 * 19.4 M and 14.8 M times and return `true` **zero** times, because the
 * registry never gets a single barrier. The size is re-read on every query
 * (never cached), so a barrier raised mid-run is honoured immediately.
 */
export function attachBarriersToFloorMap(world: BarrierWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  floorMap.setBarrierLookup((tileX, tileY) => {
    // Recompute tile index each call — cheap, and safer than caching
    // across possible map resizes.
    const idx = floorMap.tileMap.index(tileX, tileY);
    if (idx < 0) return false;
    return isBarrierTile(world, idx);
  }, world);
  // Feet-precision lookup for analytic barriers (e.g. a 1 ft-thick ring wall)
  // that are too thin to represent as 4 ft tiles. `isPassableAt` consults this
  // in addition to the tile lookup.
  floorMap.setBarrierPointLookup((xFt, yFt) => isBarrierPointBlocked(world, xFt, yFt), world);
}
