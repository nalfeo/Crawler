/**
 * Pure, deterministic Floor-1 objective travel-time estimator.
 *
 * The AI has perfect world knowledge; when we can compute an A* tile path
 * through the current floor's known-passable tiles, that path length is a much
 * better travel-time estimate than raw straight-line Euclidean distance
 * (walls, doors, and corridors add real time in narrow rooms). This module
 * wraps that computation in a small, testable pure surface so the run planner
 * and the collapse-panic profile can share a single, deterministic estimator
 * for player→objective travel time.
 *
 * The wall-safety fallback runs when A* is unavailable (no floor map yet, no
 * adapters passed, or the path search fails) so callers always get a finite
 * estimate. The fallback multiplies straight-line distance by
 * {@link ObjectiveTravelEstimatorParams.wallSafetyFactor} plus a small buffer
 * so it always exceeds the raw straight-line travel time (the run planner's
 * default estimate).
 *
 * Pure: no side effects, no hidden state, no Math.random(), no Date.now().
 */

export interface ObjectiveTravelPoint {
  readonly x: number;
  readonly y: number;
}

export interface ObjectiveTravelTile {
  readonly x: number;
  readonly y: number;
}

/**
 * Minimal adapter surface the estimator needs to consult a floor's pathfinding
 * layer without importing `FloorMap` or `findTilePath` directly. Callers wire
 * these to real engine functions; tests can inject deterministic fakes.
 */
export interface ObjectiveTravelAdapters {
  /** Convert world feet coords → tile coords. */
  readonly worldToTile: (x: number, y: number) => ObjectiveTravelTile;
  /**
   * Compute a tile-space path from start to goal. Return an empty array when
   * no path exists (matches `findTilePath`'s contract). Consecutive tiles in
   * the returned path must be 4-connected — the estimator counts inter-tile
   * hops to derive travel distance.
   */
  readonly findTilePath: (
    start: ObjectiveTravelTile,
    goal: ObjectiveTravelTile,
  ) => readonly ObjectiveTravelTile[];
  /** Tile edge length in world feet (needed to convert hop count → feet). */
  readonly tileSizeFt: number;
}

export interface ObjectiveTravelEstimatorParams {
  /** Player movement speed in world feet per millisecond. Must be positive. */
  readonly moveSpeedFtPerMs: number;
  /**
   * Multiplier applied to straight-line distance when A* is not available.
   * Walls / doorways typically add 30–80% to the raw Euclidean straight-line
   * distance; the default value covers most realistic Floor-1 room layouts.
   */
  readonly wallSafetyFactor: number;
  /**
   * Fixed additive buffer, in milliseconds, added to the fallback estimate.
   * Small constant that keeps the fallback strictly larger than the raw
   * straight-line travel time even for very short distances (where the
   * multiplier alone would barely bump the estimate).
   */
  readonly wallSafetyBufferMs: number;
}

export interface ObjectiveTravelEstimate {
  readonly travelMs: number;
  readonly distanceFt: number;
  readonly usedAStar: boolean;
}

const EPSILON = 1e-6;

function euclidean(a: ObjectiveTravelPoint, b: ObjectiveTravelPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function fallbackEstimate(
  from: ObjectiveTravelPoint,
  to: ObjectiveTravelPoint,
  params: ObjectiveTravelEstimatorParams,
): ObjectiveTravelEstimate {
  const distanceFt = euclidean(from, to);
  const safetyFactor = Math.max(1, params.wallSafetyFactor);
  const bufferMs = Math.max(0, params.wallSafetyBufferMs);
  const speed = Math.max(params.moveSpeedFtPerMs, EPSILON);
  const inflated = distanceFt * safetyFactor;
  return {
    travelMs: inflated / speed + bufferMs,
    distanceFt,
    usedAStar: false,
  };
}

/**
 * Estimate travel time between two world-space points using an A*-computed
 * tile path when adapters are supplied, or a straight-line-plus-safety fallback
 * otherwise. Deterministic given identical inputs.
 *
 * @param from   World-space start point (feet).
 * @param to     World-space goal point (feet).
 * @param adapters Optional pathfinding adapters. When `null`, the estimator
 *   returns the straight-line fallback.
 * @param params Estimator tuning (move speed + fallback safety factor).
 */
export function estimateObjectiveTravelMs(
  from: ObjectiveTravelPoint,
  to: ObjectiveTravelPoint,
  adapters: ObjectiveTravelAdapters | null,
  params: ObjectiveTravelEstimatorParams,
): ObjectiveTravelEstimate {
  if (!adapters) {
    return fallbackEstimate(from, to, params);
  }

  const startTile = adapters.worldToTile(from.x, from.y);
  const goalTile = adapters.worldToTile(to.x, to.y);
  const path = adapters.findTilePath(startTile, goalTile);
  if (path.length < 1) {
    return fallbackEstimate(from, to, params);
  }

  // Path length in feet is (hop count) × tileSize. The path array includes the
  // start tile as the first entry, so the number of hops between tiles is
  // path.length - 1. When start === goal, path is a single tile → 0 hops.
  const tileSizeFt = Math.max(EPSILON, adapters.tileSizeFt);
  const hops = Math.max(0, path.length - 1);
  const distanceFt = hops * tileSizeFt;
  const speed = Math.max(params.moveSpeedFtPerMs, EPSILON);
  return {
    travelMs: distanceFt / speed,
    distanceFt,
    usedAStar: true,
  };
}
