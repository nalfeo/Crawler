/**
 * flow-field.ts — shared single-source pathfinding for dense swarms.
 *
 * Every chasing enemy on a floor heads for the *same* goal: the player's tile.
 * Running an independent A* search per enemy therefore re-derives the same
 * routing information dozens of times per frame — the dominant CPU cost in dense
 * ranged fights, where a kiting player forces a fresh search for every mob almost
 * every time anyone crosses a tile boundary.
 *
 * Swarm and bullet-hell games avoid this with a *flow field*: one breadth-first
 * sweep outward from the goal computes the shortest-path distance to every
 * reachable tile, after which each agent simply steps to the neighbouring tile
 * with the lower distance — an O(1) gradient lookup. N expensive A* searches
 * collapse into a single BFS plus N trivial lookups, and because the field is
 * rebuilt from the player's *current* tile, pursuit stays exactly as tight as
 * per-enemy A* (it is the same shortest-path data), with none of the staleness
 * that cheaper "re-path less often" hacks introduce.
 *
 * Pure core: no rendering, ECS, or game imports. Deterministic — the BFS visits
 * tiles in a fixed neighbour order and {@link flowFieldStep} breaks ties by the
 * same order, so identical inputs always yield identical routing.
 */

import type { FloorMap } from './FloorMap.js';
import { isTileTraversable, PATH_TRAVERSAL, type TilePoint } from './pathfinding.js';

/** Distance marker for tiles the goal sweep never reached (walls, sealed areas). */
export const FLOW_UNREACHABLE = -1;

/**
 * Neighbour order for {@link flowFieldStep}: the four cardinals first (so they
 * win ties), then the four diagonals. Descending to diagonals lets a chaser cut
 * a straight diagonal line toward the player instead of stair-stepping, while a
 * corner-cut guard keeps it from clipping through wall corners.
 */
const FLOW_STEP_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface FlowField {
  readonly width: number;
  readonly height: number;
  /** Goal tile the field flows toward (distance 0). */
  readonly goalX: number;
  readonly goalY: number;
  /**
   * Shortest-path tile distance from each tile to the goal, indexed
   * `y * width + x`. {@link FLOW_UNREACHABLE} for blocked or unreachable tiles.
   */
  readonly distance: Int32Array;
}

export interface FlowFieldOptions {
  traversalMode?: number;
  /**
   * Optional GROUND passability override, mirroring {@link PathfindingOptions}.
   * Must match whatever predicate the consuming pathfinder uses so the field
   * routes identically. Ignored for FLYING traversal.
   */
  isTilePassable?: (x: number, y: number) => boolean;
}

/**
 * Build a flow field that flows toward `goal` across all reachable tiles.
 *
 * Cost is O(reachable tiles): a single breadth-first sweep. Rebuild it when the
 * goal tile moves or the traversable layout changes (e.g. doors) — once per
 * change, shared by every agent that frame.
 */
export function computeFlowField(
  floorMap: FloorMap,
  goal: TilePoint,
  options: FlowFieldOptions = {},
): FlowField {
  const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
  const isTilePassable = options.isTilePassable;
  const width = floorMap.tileMap.width;
  const height = floorMap.tileMap.height;
  const distance = new Int32Array(width * height).fill(FLOW_UNREACHABLE);

  const field: FlowField = { width, height, goalX: goal.x, goalY: goal.y, distance };

  if (
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
  ) {
    return field;
  }

  const goalIndex = goal.y * width + goal.x;
  distance[goalIndex] = 0;

  // Fixed-size FIFO queue (every tile is enqueued at most once).
  const queue = new Int32Array(width * height);
  queue[0] = goalIndex;
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const idx = queue[head]!;
    head += 1;
    const cx = idx % width;
    const cy = (idx - cx) / width;
    const nextDistance = distance[idx]! + 1;

    const rightX = cx + 1;
    if (rightX < width) {
      const rightIdx = cy * width + rightX;
      if (
        distance[rightIdx] === FLOW_UNREACHABLE &&
        isTileTraversable(floorMap, rightX, cy, traversalMode, isTilePassable)
      ) {
        distance[rightIdx] = nextDistance;
        queue[tail] = rightIdx;
        tail += 1;
      }
    }

    const leftX = cx - 1;
    if (leftX >= 0) {
      const leftIdx = cy * width + leftX;
      if (
        distance[leftIdx] === FLOW_UNREACHABLE &&
        isTileTraversable(floorMap, leftX, cy, traversalMode, isTilePassable)
      ) {
        distance[leftIdx] = nextDistance;
        queue[tail] = leftIdx;
        tail += 1;
      }
    }

    const downY = cy + 1;
    if (downY < height) {
      const downIdx = downY * width + cx;
      if (
        distance[downIdx] === FLOW_UNREACHABLE &&
        isTileTraversable(floorMap, cx, downY, traversalMode, isTilePassable)
      ) {
        distance[downIdx] = nextDistance;
        queue[tail] = downIdx;
        tail += 1;
      }
    }

    const upY = cy - 1;
    if (upY >= 0) {
      const upIdx = upY * width + cx;
      if (
        distance[upIdx] === FLOW_UNREACHABLE &&
        isTileTraversable(floorMap, cx, upY, traversalMode, isTilePassable)
      ) {
        distance[upIdx] = nextDistance;
        queue[tail] = upIdx;
        tail += 1;
      }
    }
  }

  return field;
}

/**
 * Unit step toward the goal from `(x, y)` — one of the eight
 * {@link FLOW_STEP_DIRECTIONS} — or `null` when the tile is the goal,
 * unreachable, or a local minimum with no downhill neighbour.
 *
 * The descent considers diagonals as well as cardinals and always takes the
 * strictly-most-downhill neighbour, so a chaser in open space glides along a
 * straight diagonal toward the player rather than stair-stepping. A diagonal is
 * only eligible when both orthogonal cells it grazes are themselves reachable,
 * which forbids cutting across a wall corner. Because the underlying field is a
 * 4-connected BFS, every reachable non-goal tile has a cardinal neighbour one
 * step closer, so a downhill move always exists and ties break by neighbour
 * order for determinism.
 */
export function flowFieldStep(field: FlowField, x: number, y: number): TilePoint | null {
  if (x < 0 || y < 0 || x >= field.width || y >= field.height) {
    return null;
  }
  const here = field.distance[y * field.width + x]!;
  if (here === FLOW_UNREACHABLE || here === 0) {
    return null;
  }

  const distAt = (nx: number, ny: number): number => {
    if (nx < 0 || ny < 0 || nx >= field.width || ny >= field.height) {
      return FLOW_UNREACHABLE;
    }
    return field.distance[ny * field.width + nx]!;
  };

  let bestDistance = here;
  let bestDir: TilePoint | null = null;
  for (const [dx, dy] of FLOW_STEP_DIRECTIONS) {
    const neighbor = distAt(x + dx, y + dy);
    if (neighbor === FLOW_UNREACHABLE) {
      continue;
    }
    // Diagonals must not slip through a wall corner: both orthogonally adjacent
    // cells have to be reachable too.
    if (
      dx !== 0 &&
      dy !== 0 &&
      (distAt(x + dx, y) === FLOW_UNREACHABLE || distAt(x, y + dy) === FLOW_UNREACHABLE)
    ) {
      continue;
    }
    if (neighbor < bestDistance) {
      bestDistance = neighbor;
      bestDir = { x: dx, y: dy };
    }
  }
  return bestDir;
}
