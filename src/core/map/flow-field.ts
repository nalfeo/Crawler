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
import { indexToCoords } from './grid-utils.js';

/** Distance marker for tiles the goal sweep never reached (walls, sealed areas). */
export const FLOW_UNREACHABLE = -1;

/**
 * Fixed neighbour order for the BFS sweep (4-connected, matching
 * {@link findTilePath}'s topology). The distance field itself stays 4-connected
 * — cheap to build and a true shortest-path metric — while {@link flowFieldStep}
 * layers diagonal descent on top for natural movement. Order must stay stable
 * for deterministic routing.
 */
const FLOW_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

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
  /** Field width in tiles (window width; may be smaller than the full map). */
  readonly width: number;
  /** Field height in tiles (window height; may be smaller than the full map). */
  readonly height: number;
  /** Goal tile in absolute tile coordinates. */
  readonly goalX: number;
  /** Goal tile in absolute tile coordinates. */
  readonly goalY: number;
  /**
   * Absolute tile coordinate of the top-left corner of this field window.
   * When the field covers the full map this is (0, 0).  {@link flowFieldStep}
   * and {@link computeFlowField} use this to translate between absolute tile
   * coords and field-local array indices.
   */
  readonly originX: number;
  readonly originY: number;
  /**
   * Shortest-path tile distance from each tile to the goal, indexed
   * `(y - originY) * width + (x - originX)`.
   * {@link FLOW_UNREACHABLE} for blocked, out-of-window, or unreachable tiles.
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
  /**
   * Restrict the BFS to this absolute-tile bounding box.  Tiles outside the
   * window are treated as {@link FLOW_UNREACHABLE} — enemies there fall back
   * to per-enemy A* pathfinding (same as today for unreachable tiles).
   *
   * Omit (or pass `undefined`) to cover the full map.
   */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Build a flow field that flows toward `goal` across all reachable tiles.
 *
 * Cost is O(reachable tiles): a single breadth-first sweep. Rebuild it when the
 * goal tile moves or the traversable layout changes (e.g. doors) — once per
 * change, shared by every agent that frame.
 *
 * When `options.bounds` is provided the BFS is restricted to that bounding box
 * (clamped to map extents). Tiles outside the window have distance
 * {@link FLOW_UNREACHABLE} — consumers fall back to per-entity A* for those.
 * `field.originX/Y` records the top-left corner of the active window so that
 * {@link flowFieldStep} can translate absolute tile coords to field-local indices.
 */
export function computeFlowField(
  floorMap: FloorMap,
  goal: TilePoint,
  options: FlowFieldOptions = {},
): FlowField {
  const traversalMode = options.traversalMode ?? PATH_TRAVERSAL.GROUND;
  const isTilePassable = options.isTilePassable;
  const mapWidth = floorMap.tileMap.width;
  const mapHeight = floorMap.tileMap.height;

  // Determine window: clamp requested bounds (or default to full map).
  let originX: number;
  let originY: number;
  let winWidth: number;
  let winHeight: number;
  if (options.bounds) {
    originX = Math.max(0, options.bounds.minX);
    originY = Math.max(0, options.bounds.minY);
    const maxX = Math.min(mapWidth - 1, options.bounds.maxX);
    const maxY = Math.min(mapHeight - 1, options.bounds.maxY);
    winWidth = maxX - originX + 1;
    winHeight = maxY - originY + 1;
  } else {
    originX = 0;
    originY = 0;
    winWidth = mapWidth;
    winHeight = mapHeight;
  }

  const distance = new Int32Array(winWidth * winHeight).fill(FLOW_UNREACHABLE);
  const field: FlowField = {
    width: winWidth,
    height: winHeight,
    goalX: goal.x,
    goalY: goal.y,
    originX,
    originY,
    distance,
  };

  // Goal must be within the active window and traversable.
  const localGoalX = goal.x - originX;
  const localGoalY = goal.y - originY;
  if (
    localGoalX < 0 ||
    localGoalX >= winWidth ||
    localGoalY < 0 ||
    localGoalY >= winHeight ||
    !floorMap.tileMap.inBounds(goal.x, goal.y) ||
    !isTileTraversable(floorMap, goal.x, goal.y, traversalMode, isTilePassable)
  ) {
    return field;
  }

  const goalIndex = localGoalY * winWidth + localGoalX;
  distance[goalIndex] = 0;

  // Plain array used as a FIFO queue with a moving head cursor — cheaper than
  // Array.shift() and fully deterministic.
  const queue: number[] = [goalIndex];
  let head = 0;

  while (head < queue.length) {
    const idx = queue[head]!;
    head += 1;
    const [lcx, lcy] = indexToCoords(idx, winWidth);
    const cx = lcx + originX;
    const cy = lcy + originY;
    const nextDistance = distance[idx]! + 1;

    for (const [dx, dy] of FLOW_DIRECTIONS) {
      const nx = cx + dx;
      const ny = cy + dy;
      // Clamp to window (not just map bounds) — tiles outside the window
      // are left FLOW_UNREACHABLE regardless of traversability.
      const lnx = nx - originX;
      const lny = ny - originY;
      if (lnx < 0 || lnx >= winWidth || lny < 0 || lny >= winHeight) {
        continue;
      }
      const nIdx = lny * winWidth + lnx;
      if (distance[nIdx] !== FLOW_UNREACHABLE) {
        continue;
      }
      if (!isTileTraversable(floorMap, nx, ny, traversalMode, isTilePassable)) {
        continue;
      }
      distance[nIdx] = nextDistance;
      queue.push(nIdx);
    }
  }

  return field;
}

/**
 * Unit step toward the goal from absolute tile `(x, y)` — one of the eight
 * {@link FLOW_STEP_DIRECTIONS} — or `null` when the tile is the goal,
 * unreachable, outside the field window, or a local minimum with no downhill
 * neighbour.
 *
 * The descent considers diagonals as well as cardinals and always takes the
 * strictly-most-downhill neighbour, so a chaser in open space glides along a
 * straight diagonal toward the player rather than stair-stepping. A diagonal is
 * only eligible when both orthogonal cells it grazes are themselves reachable,
 * which forbids cutting across a wall corner. Because the underlying field is a
 * 4-connected BFS, every reachable non-goal tile has a cardinal neighbour one
 * step closer, so a downhill move always exists and ties break by neighbour
 * order for determinism.
 *
 * @param x - Absolute tile X coordinate.
 * @param y - Absolute tile Y coordinate.
 */
export function flowFieldStep(field: FlowField, x: number, y: number): TilePoint | null {
  // Translate absolute → field-local.
  const lx = x - field.originX;
  const ly = y - field.originY;
  if (lx < 0 || ly < 0 || lx >= field.width || ly >= field.height) {
    return null;
  }
  const here = field.distance[ly * field.width + lx]!;
  if (here === FLOW_UNREACHABLE || here === 0) {
    return null;
  }

  const distAt = (nx: number, ny: number): number => {
    const lnx = nx - field.originX;
    const lny = ny - field.originY;
    if (lnx < 0 || lny < 0 || lnx >= field.width || lny >= field.height) {
      return FLOW_UNREACHABLE;
    }
    return field.distance[lny * field.width + lnx]!;
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
