import { Path } from 'rot-js';

import type { FloorMap } from './FloorMap.js';
import { computeGridPath } from './astar-grid.js';

export const PATH_TRAVERSAL = {
  GROUND: 0,
  FLYING: 1,
} as const;

export interface PathfindingOptions {
  traversalMode?: number;
  maxPathLength?: number;
  /** @deprecated Use maxPathLength instead. */
  maxVisited?: number;
  /**
   * Optional passability override for GROUND traversal. When provided, this
   * predicate decides whether a tile may be traversed instead of the default
   * `tileMap.isPassable` check. Callers use this to plan routes through doors
   * (which auto-open on approach) while still treating known-locked doors as
   * walls. Out-of-bounds tiles are rejected before this is consulted. The
   * FLYING traversal mode ignores this override.
   */
  isTilePassable?: (x: number, y: number) => boolean;
}

export interface TilePoint {
  x: number;
  y: number;
}

const DEFAULT_MAX_PATH_LENGTH = 4_096;

export function isTileTraversable(
  floorMap: FloorMap,
  x: number,
  y: number,
  traversalMode: number,
  isTilePassable?: (x: number, y: number) => boolean,
): boolean {
  if (!floorMap.tileMap.inBounds(x, y)) {
    return false;
  }

  if (traversalMode === PATH_TRAVERSAL.FLYING) {
    // Flying paths ignore the tile-flag layer, but barriers are a physical
    // energy overlay that fills the tile top-to-bottom — grounded and flying
    // entities alike bounce off. Skipping the barrier check here would let
    // A* plan flying routes straight through a spawner's arena fence, which
    // is exactly the class of leak this primitive exists to eliminate.
    return !floorMap.hasBarrierAtTile(x, y);
  }

  if (isTilePassable) {
    // Callers that provide a custom passability override (e.g. door-aware
    // routing) still need barriers layered on top — a locked door predicate
    // doesn't imply the tile is safe if a live barrier occupies it.
    return isTilePassable(x, y) && !floorMap.hasBarrierAtTile(x, y);
  }

  return floorMap.tileMap.isPassable(x, y) && !floorMap.hasBarrierAtTile(x, y);
}

export function findTilePath(
  floorMap: FloorMap,
  start: TilePoint,
  goal: TilePoint,
  options: PathfindingOptions = {},
): TilePoint[] {
  const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
  const isTilePassable = options.isTilePassable;
  const maxPathLength = Math.max(
    1,
    options.maxPathLength ?? options.maxVisited ?? DEFAULT_MAX_PATH_LENGTH,
  );

  if (
    !floorMap.tileMap.inBounds(start.x, start.y) ||
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    !isTileTraversable(floorMap, start.x, start.y, traversalMode, isTilePassable) ||
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
  ) {
    return [];
  }

  if (start.x === goal.x && start.y === goal.y) {
    return [{ x: start.x, y: start.y }];
  }

  const result: TilePoint[] = [];
  let visited = 0;
  const passable = (x: number, y: number): boolean =>
    isTileTraversable(floorMap, x, y, traversalMode, isTilePassable);
  const visit = (x: number, y: number): void => {
    if (visited < maxPathLength) {
      result.push({ x, y });
    }
    visited += 1;
  };

  if (
    Number.isInteger(start.x) &&
    Number.isInteger(start.y) &&
    Number.isInteger(goal.x) &&
    Number.isInteger(goal.y)
  ) {
    // Search order, tie-breaking, and emitted order are byte-identical to the
    // rot-js `Path.AStar` below — see `astar-grid.ts` for the contract.
    computeGridPath(
      floorMap.tileMap.width,
      floorMap.tileMap.height,
      start.x,
      start.y,
      goal.x,
      goal.y,
      passable,
      visit,
    );
  } else {
    // `TileMap.inBounds` accepts fractional coordinates, so a caller supplying a
    // permissive `isTilePassable` override (or FLYING traversal over a barrier-free
    // region) can legitimately search a fractional lattice that no tile-indexed
    // grid can represent. Preserve the historical rot-js behaviour verbatim for
    // that case rather than silently changing the result.
    const astar = new Path.AStar(goal.x, goal.y, passable, { topology: 4 });
    astar.compute(start.x, start.y, visit);
  }

  if (result.length === 0) {
    return [];
  }
  if (result[result.length - 1]!.x !== goal.x || result[result.length - 1]!.y !== goal.y) {
    return [];
  }
  return result;
}
