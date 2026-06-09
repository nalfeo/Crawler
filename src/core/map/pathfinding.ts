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
}

export interface TilePoint {
  x: number;
  y: number;
}

const DEFAULT_MAX_PATH_LENGTH = 4_096;

function isTileTraversable(
  floorMap: FloorMap,
  x: number,
  y: number,
  traversalMode: number,
): boolean {
  if (!floorMap.tileMap.inBounds(x, y)) {
    return false;
  }

  if (traversalMode === PATH_TRAVERSAL.FLYING) {
    return true;
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
  const maxPathLength = Math.max(
    1,
    options.maxPathLength ?? options.maxVisited ?? DEFAULT_MAX_PATH_LENGTH,
  );

  if (
    !floorMap.tileMap.inBounds(start.x, start.y) ||
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    !isTileTraversable(floorMap, start.x, start.y, traversalMode) ||
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode)
  ) {
    return [];
  }

  if (start.x === goal.x && start.y === goal.y) {
    return [{ x: start.x, y: start.y }];
  }

  const astar = new Path.AStar(
    goal.x,
    goal.y,
    (x: number, y: number) => isTileTraversable(floorMap, x, y, traversalMode),
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
