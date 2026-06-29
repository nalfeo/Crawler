import { LINE_OF_SIGHT_SAMPLE_FT } from './bt-ai-tuning.js';

/**
 * Minimal structural view of a floor map needed for line-of-sight sampling.
 *
 * Declared structurally (rather than importing the concrete `FloorMap`) so the
 * geometry stays a pure, dependency-light function that unit tests can drive
 * with a tiny fake grid instead of constructing a full tile map + room graph.
 * The real {@link FloorMap} satisfies this shape.
 */
export interface LineOfSightMap {
  isPassableAt(x: number, y: number): boolean;
  worldToTile(x: number, y: number): { x: number; y: number };
}

/**
 * Sample the straight corridor between two world points and report whether
 * every sampled position is on passable ground. Used to decide when the AI may
 * abandon tile-granular A* for a direct sub-tile approach onto a close target
 * (see CLOSE_APPROACH_DIRECT_FT). Returns false when no floor map is present so
 * the caller keeps its existing A* / local-nav fallback.
 *
 * Pure: depends only on its arguments (no `this`, no module state, no RNG/time),
 * so the result is fully determined by the map + endpoints + step size.
 */
export function hasClearLineOfSight(
  floorMap: LineOfSightMap | null | undefined,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  sampleStepFt: number = LINE_OF_SIGHT_SAMPLE_FT,
): boolean {
  if (!floorMap) {
    return false;
  }
  const distance = Math.hypot(endX - startX, endY - startY);
  if (distance <= 0) {
    return floorMap.isPassableAt(endX, endY);
  }
  const steps = Math.max(1, Math.ceil(distance / sampleStepFt));
  let prevX = startX;
  let prevY = startY;
  let prevTile = floorMap.worldToTile(startX, startY);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sampleX = startX + (endX - startX) * t;
    const sampleY = startY + (endY - startY) * t;
    if (!floorMap.isPassableAt(sampleX, sampleY)) {
      return false;
    }
    const sampleTile = floorMap.worldToTile(sampleX, sampleY);
    const crossesBlockedCorner =
      sampleTile.x !== prevTile.x &&
      sampleTile.y !== prevTile.y &&
      !floorMap.isPassableAt(sampleX, prevY) &&
      !floorMap.isPassableAt(prevX, sampleY);
    if (crossesBlockedCorner) {
      return false;
    }
    prevX = sampleX;
    prevY = sampleY;
    prevTile = sampleTile;
  }
  return true;
}
