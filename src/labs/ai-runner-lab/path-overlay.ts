/**
 * Path overlay geometry for the AI Runner Lab.
 *
 * The behaviour-tree AI plans on a 4-connected grid, so the raw waypoints it
 * stores stair-step in cardinal hops. At runtime the provider string-pulls that
 * path (see `BehaviorTreeAI.smoothPathIndex` / `hasClearLineOfSight`): it steers
 * straight at the farthest upcoming waypoint it has an unobstructed line of sight
 * to, which produces the diagonal/arcing motion now seen on screen.
 *
 * Drawing the raw waypoints therefore makes the overlay zigzag even though the
 * player is gliding diagonally. The helpers here reconstruct the same string-pull
 * so the overlay tracks the path the AI actually walks.
 */

export interface OverlayPoint {
  x: number;
  y: number;
}

/** Pixel spacing between line-of-sight samples; mirrors the AI provider. */
export const OVERLAY_LINE_OF_SIGHT_SAMPLE_PX = 8;

/**
 * Sample the straight corridor between two points and report whether every
 * sampled position is passable. Mirrors `BehaviorTreeAI.hasClearLineOfSight` so
 * the overlay's diagonal shortcuts match the ones the AI actually takes.
 */
export function hasClearLineOfSight(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  isPassable: (x: number, y: number) => boolean,
  sampleSpacingPx: number = OVERLAY_LINE_OF_SIGHT_SAMPLE_PX,
): boolean {
  const distance = Math.hypot(endX - startX, endY - startY);
  if (distance <= 0) {
    return isPassable(endX, endY);
  }
  const steps = Math.max(1, Math.ceil(distance / sampleSpacingPx));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sampleX = startX + (endX - startX) * t;
    const sampleY = startY + (endY - startY) * t;
    if (!isPassable(sampleX, sampleY)) {
      return false;
    }
  }
  return true;
}

/**
 * Build the diagonal polyline the AI actually traverses, in pixel space.
 *
 * Starting from `start` (the player), repeatedly jump to the farthest remaining
 * waypoint that has a clear line of sight, exactly like the provider's
 * string-pull. When no upcoming waypoint is visible (a corner the AI would clip
 * and recover from), it falls back to the next waypoint so the polyline always
 * makes forward progress and terminates.
 *
 * @param start Player position in world pixels.
 * @param waypoints Upcoming path waypoints in world pixels (already sliced to the
 *   active path index — points behind the player should not be included).
 * @param isPassable Passability predicate in world-pixel space.
 * @param sampleSpacingPx Line-of-sight sample spacing.
 * @returns Smoothed polyline including `start` as the first point. Returns a
 *   single-point array (just `start`) when there are no waypoints.
 */
export function buildSmoothedOverlayPath(
  start: OverlayPoint,
  waypoints: readonly OverlayPoint[],
  isPassable: (x: number, y: number) => boolean,
  sampleSpacingPx: number = OVERLAY_LINE_OF_SIGHT_SAMPLE_PX,
): OverlayPoint[] {
  const smoothed: OverlayPoint[] = [{ x: start.x, y: start.y }];

  let anchor: OverlayPoint = start;
  let index = 0;
  while (index < waypoints.length) {
    // Scan backward from the path end to find the farthest visible waypoint,
    // maximizing the diagonal shortcut while respecting walls.
    let next = index;
    for (let i = waypoints.length - 1; i > index; i--) {
      const candidate = waypoints[i];
      if (!candidate) {
        continue;
      }
      if (
        hasClearLineOfSight(
          anchor.x,
          anchor.y,
          candidate.x,
          candidate.y,
          isPassable,
          sampleSpacingPx,
        )
      ) {
        next = i;
        break;
      }
    }

    const target = waypoints[next];
    if (!target) {
      break;
    }
    smoothed.push({ x: target.x, y: target.y });
    anchor = target;
    // Always advance past the chosen waypoint so the loop terminates even when
    // the very next waypoint is the only reachable one.
    index = next + 1;
  }

  return smoothed;
}
