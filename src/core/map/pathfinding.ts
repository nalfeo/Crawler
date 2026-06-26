import { Path } from 'rot-js';
import type { FloorMap } from './FloorMap.js';

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
    return true;
  }

  if (isTilePassable) {
    return isTilePassable(x, y);
  }

  return floorMap.tileMap.isPassable(x, y);
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

  const astar = new Path.AStar(
    goal.x,
    goal.y,
    (x: number, y: number) => isTileTraversable(floorMap, x, y, traversalMode, isTilePassable),
    { topology: 4 },
  );
  const result: TilePoint[] = [];
  let visited = 0;

  astar.compute(start.x, start.y, (x: number, y: number) => {
    if (visited < maxPathLength) {
      result.push({ x, y });
    }
    visited += 1;
  });

  if (result.length === 0) {
    return [];
  }
  if (result[result.length - 1]!.x !== goal.x || result[result.length - 1]!.y !== goal.y) {
    return [];
  }
  return result;
}
