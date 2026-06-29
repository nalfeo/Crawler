/**
 * Pure 2D vector helpers shared across core/game logic. Feet are the internal
 * spatial unit (see units.ts); these helpers are unit-agnostic scalar math.
 *
 * Consolidates the near-duplicate `normalize` (enemyAISystem) and
 * `normalizeVector` (weaponSystem) implementations and the 60+ scattered
 * `Math.hypot` distance calls. Keep this layer pure and deterministic.
 */

/** Threshold below which a vector is treated as zero-length. */
export const VEC_EPSILON = 0.0001;

/** Magnitude of a 2D vector. */
export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** Euclidean distance between two points. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Squared distance — cheaper than `distance` when only comparing magnitudes. */
export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export interface NormalizedVector {
  x: number;
  y: number;
  length: number;
}

/**
 * Normalize a 2D vector to unit length. For zero-length input (|v| <= VEC_EPSILON)
 * returns the supplied fallback direction with `length: 0`, defaulting to (0, 0)
 * so callers can detect the degenerate case via `length`.
 */
export function normalize(x: number, y: number, fallbackX = 0, fallbackY = 0): NormalizedVector {
  const len = Math.hypot(x, y);
  if (len <= VEC_EPSILON) {
    return { x: fallbackX, y: fallbackY, length: 0 };
  }
  return { x: x / len, y: y / len, length: len };
}
