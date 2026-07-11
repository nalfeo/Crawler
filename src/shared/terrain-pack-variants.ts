/**
 * Deterministic variant selection for terrain packs.
 *
 * Every picker here is a PURE function of (pool/pack, seed, coordinates) — no
 * `Math.random()`, no hidden mutable state. Given the same floor seed and the
 * same tile coordinate, the same variant is always chosen, so floor/corridor
 * texture variety is stable across renders and replays (reviewed-design:
 * "deterministic variants derive only from stable seed + coordinates").
 */
import { hashStringToSeed, SeededRandom } from './random.js';
import type { DoorSetDef, PoolVariantDef } from './terrain-pack-types.js';
import type { DoorOrientation } from './terrain-pack-types.js';

/**
 * Derive a per-tile deterministic seed from a floor seed and tile coordinates.
 *
 * Combines the floor's numeric seed with a hash of the "x,y" coordinate string
 * so neighbouring tiles don't draw correlated values from a shared counter,
 * while the SAME (seed, x, y) triple always reproduces the SAME value.
 */
export function deriveTileVariantSeed(floorSeed: number, tx: number, ty: number): number {
  const coordHash = hashStringToSeed(`${tx},${ty}`);
  // XOR combine two well-mixed 32-bit values; result is re-mixed by
  // SeededRandom's xorshift on first `next()` call, so simple XOR combination
  // is sufficient here (no cross-seed correlation concerns for this use case).
  return (floorSeed ^ coordHash) | 0;
}

/**
 * Deterministically pick one variant from a floor or corridor pool for the
 * tile at (tx, ty), given a stable floor seed.
 *
 * Returns null when the pool is empty (callers should fall back to legacy
 * rendering in that case).
 */
export function pickPoolVariant(
  pool: readonly PoolVariantDef[],
  floorSeed: number,
  tx: number,
  ty: number,
): PoolVariantDef | null {
  if (pool.length === 0) {
    return null;
  }
  if (pool.length === 1) {
    return pool[0] ?? null;
  }
  const seed = deriveTileVariantSeed(floorSeed, tx, ty);
  return new SeededRandom(seed).pick(pool);
}

/**
 * Resolve door art orientation from wall-flank geometry.
 *
 * Convention from `procedural-surfaces.renderDoorTile`:
 * - 'horizontal' = passage runs left-right, jambs on top+bottom strips
 * - 'vertical'   = passage runs top-bottom, jambs on left+right strips
 *
 * Wall-flank geometry:
 * - `horizontalDoorway` (walls at x±1): door sits in a left-right wall run →
 *   player moves top-to-bottom through the opening → art is 'vertical'
 * - NOT `horizontalDoorway` (walls at y±1): door sits in a top-bottom wall run →
 *   player moves left-to-right through the opening → art is 'horizontal'
 */
export function resolveDoorOrientationFromFlanks(horizontalDoorway: boolean): DoorOrientation {
  return horizontalDoorway ? 'vertical' : 'horizontal';
}
export interface DoorVariantKey {
  readonly isOpen: boolean;
  readonly orientation: DoorOrientation;
}

/**
 * Pure resolver: select the terrain-pack door texture for a given
 * open/closed × horizontal/vertical state. Exactly the 4 combinations the
 * `doorSet` schema supports — no locked-door branch (out of scope, refinement
 * #5). Always returns a value (no null) since `doorSet` is a required,
 * fully-populated field on every registered pack.
 */
export function resolveDoorPoolVariant(doorSet: DoorSetDef, key: DoorVariantKey) {
  if (key.isOpen) {
    return key.orientation === 'horizontal' ? doorSet.openHorizontal : doorSet.openVertical;
  }
  return key.orientation === 'horizontal' ? doorSet.closedHorizontal : doorSet.closedVertical;
}
