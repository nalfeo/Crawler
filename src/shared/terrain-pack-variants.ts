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
import type {
  DoorSetDef,
  PoolVariantDef,
  TransformId,
  WallAccentDef,
} from './terrain-pack-types.js';
import { TRANSFORM_IDS } from './terrain-pack-types.js';
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
 * One (source variant, transform) combination a floor/corridor tile can
 * render with — the "source+transform identity" the terrain-variance spec's
 * anti-adjacency rule and diversity metrics refer to.
 */
export interface PoolCombo {
  readonly variant: PoolVariantDef;
  readonly transform: TransformId;
}

/**
 * Expand a pool into every `(variant, transform)` combo it can render, in a
 * fixed, declaration-independent order: pool order outer, `TRANSFORM_IDS`
 * order inner. Each combo carries the selection weight of its source variant
 * divided evenly across that source's eligible transforms, so a variant's
 * `weight` is its total probability regardless of how many transforms it
 * allows (otherwise a 4-transform source would silently outweigh an
 * identity-only one by 4x).
 */
interface WeightedCombo {
  readonly combo: PoolCombo;
  readonly weight: number;
}

/**
 * Memoizes the weighted combo expansion per pool array identity. Pure function
 * of the pool's contents, so computing it once per bake rather than once per
 * tile is a perf win with no determinism cost.
 */
const weightedComboCache = new WeakMap<readonly PoolVariantDef[], readonly WeightedCombo[]>();

/**
 * Build the weighted combo table for a floor/corridor pool.
 *
 * Replaces the disjoint-parity-bucket anti-adjacency construction removed on
 * 2026-07-25. That construction guaranteed orthogonal neighbours could never
 * draw the same combo — which, with a uniform draw over 8 unrelated source
 * textures, guaranteed a visible patchwork instead of continuous ground.
 * Cohesion is now a property of the ART (every variant is the shared base plus
 * an interior-only detail, so all variants share byte-identical borders), and
 * this picker's job is only to make the plain base DOMINANT and detail
 * variants sparse.
 */
export function buildWeightedCombos(pool: readonly PoolVariantDef[]): readonly WeightedCombo[] {
  const cached = weightedComboCache.get(pool);
  if (cached) return cached;
  const out: WeightedCombo[] = [];
  for (const variant of pool) {
    const allowed = new Set(variant.allowedTransforms ?? ['none']);
    const ordered = TRANSFORM_IDS.filter((t) => allowed.has(t));
    if (ordered.length === 0) continue;
    const perTransform = (variant.weight ?? 1) / ordered.length;
    for (const transform of ordered) {
      out.push({ combo: { variant, transform }, weight: perTransform });
    }
  }
  weightedComboCache.set(pool, out);
  return out;
}

/**
 * Deterministically pick one `(source, transform)` combination from a floor or
 * corridor pool for the tile at (tx, ty), given a stable floor seed.
 *
 * Selection is a WEIGHTED draw over every eligible combo (see
 * `buildWeightedCombos`): a pack declares one dominant plain base and several
 * sparse detail variants, so most tiles render the base and detail appears as
 * occasional punctuation. There is deliberately NO anti-adjacency constraint —
 * two neighbouring base tiles rendering identically is the desired outcome,
 * because that is what reads as continuous ground.
 *
 * Returns null when the pool is empty (callers fall back to legacy rendering,
 * same as `pickPoolVariant`).
 */
export function pickPoolCombo(
  pool: readonly PoolVariantDef[],
  floorSeed: number,
  tx: number,
  ty: number,
): PoolCombo | null {
  if (pool.length === 0) return null;
  const weighted = buildWeightedCombos(pool);
  if (weighted.length === 0) return null;
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  const seed = deriveTileVariantSeed(floorSeed, tx, ty);
  let roll = new SeededRandom(seed).next() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.combo;
  }
  // Floating-point tail: `roll` can land exactly on `total`. Last combo is the
  // correct fallback, never null.
  return weighted[weighted.length - 1]!.combo;
}

/** Phaser `RenderTexture.stamp()` config for one pool-combo transform. */
export interface PoolStampConfig {
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Build the stamp config for a floor/corridor pool transform. Runtime-only
 * transforms (2026-07-25 refinement #2, no pre-baked variant images):
 * center-origin (0.5, 0.5) + signed scale mirrors the texture about its own
 * middle, so callers must position the stamp at the tile's CENTER (not its
 * top-left corner) — see `terrain-renderer.ts`. `'none'` is byte-identical to
 * the pre-transform stamp config, just re-expressed around the center.
 */
export function buildPoolStampConfig(transform: TransformId, scale: number): PoolStampConfig {
  const signX = transform === 'flipH' || transform === 'flipHV' ? -1 : 1;
  const signY = transform === 'flipV' || transform === 'flipHV' ? -1 : 1;
  return { originX: 0.5, originY: 0.5, scaleX: signX * scale, scaleY: signY * scale };
}

/**
 * Deterministic wall-accent density target (2026-07-25 refinement #4):
 * fraction of wall tiles expected to receive a second accent-atlas stamp.
 * Centered in the reviewed-design's required 15–25% total-density band so
 * per-seed sampling noise on a real floor's wall-tile count stays inside the
 * band with high probability (verified empirically against Floor 2's actual
 * wall-tile count — see the terrain-pack-variants tests).
 */
export const WALL_ACCENT_DENSITY = 0.2;

/**
 * Deterministically decide whether the WALL tile at (tx, ty) gets a second
 * accent-atlas stamp and, if so, which of the pack's accent atlases. Pure
 * function of (accents, floorSeed, tx, ty, density) — no neighbor lookups (no
 * adjacency constraint applies to wall accents, only to floor/corridor pool
 * combos). Returns null when the tile is not accented or `accents` is empty.
 */
export function pickWallAccentSelection(
  accents: readonly WallAccentDef[],
  floorSeed: number,
  tx: number,
  ty: number,
  density: number = WALL_ACCENT_DENSITY,
): WallAccentDef | null {
  if (accents.length === 0) return null;
  const seed = deriveTileVariantSeed(floorSeed, tx, ty);
  const rng = new SeededRandom(seed);
  if (rng.next() >= density) return null;
  return rng.pick(accents);
}

/** Default fraction of decal ANCHOR cells (not tiles) that receive a stamp. */
export const GROUND_DECAL_DENSITY = 0.75;

/**
 * Deterministically decide whether the decal anchor at (ax, ay) — a coarse-grid
 * cell, not a tile — receives a ground decal, and if so which atlas frame, at
 * what sub-cell offset, and in which orientation.
 *
 * `setIndex` salts the hash so two decal sets evaluated over the same map do not
 * draw correlated values: without it a 2×2 set would skip exactly the anchors a
 * 3×3 set skips wherever their lattices coincide, re-creating the very bands the
 * second set exists to fill.
 *
 * ORIENTATION AND SUB-TILE OFFSET. A square decal stamped axis-aligned on the
 * tile grid shows the same image the same way up at the same alignment every
 * time it recurs, which reads as tiling however many frames the atlas has.
 * `rotationDeg` is CONTINUOUS rather than a quarter turn on purpose: a quarter
 * turn maps horizontal to vertical, so it cannot break the alignment of a crack
 * that already runs along an axis — and measured over the shipped atlases the
 * mean principal-axis angle sits only ~30 degrees off an axis, with several
 * frames within 13 degrees. Quarter turns leave those frames grid-locked.
 * `flipX` adds the reflection those rotations do not cover, and
 * `subTileX/subTileY` shift the stamp by a fraction of a tile so a decal edge
 * does not coincide with a tile edge.
 *
 * Pure function of (frames, floorSeed, ax, ay, density, setIndex); returns null
 * when the anchor is unused or the atlas is empty.
 */
export function pickGroundDecal(
  frames: number,
  floorSeed: number,
  ax: number,
  ay: number,
  density: number = GROUND_DECAL_DENSITY,
  setIndex = 0,
): {
  frame: number;
  offsetX: number;
  offsetY: number;
  rotationDeg: number;
  flipX: boolean;
  subTileX: number;
  subTileY: number;
} | null {
  if (frames <= 0) return null;
  // Offset the coordinate hash so a decal anchor never draws the same value as
  // the wall accent / pool pickers at the same integer coordinate.
  const seed = deriveTileVariantSeed(
    floorSeed,
    ax + 4093 + setIndex * 131,
    ay + 7919 + setIndex * 197,
  );
  const rng = new SeededRandom(seed);
  if (rng.next() >= density) return null;
  const frame = Math.min(frames - 1, Math.floor(rng.next() * frames));
  const offsetX = rng.next();
  const offsetY = rng.next();
  const rotationDeg = rng.next() * 360;
  const flipX = rng.next() < 0.5;
  return {
    frame,
    offsetX,
    offsetY,
    rotationDeg,
    flipX,
    subTileX: rng.next(),
    subTileY: rng.next(),
  };
}

/**
 * Half-width, in pixels, of the axis-aligned bounding box of a `sizePx` square
 * rotated by `rotationDeg` about its centre. A square rotated off-axis sweeps
 * its corners outside its own footprint (up to sqrt(2)/2 * size at 45 degrees),
 * so the renderer must test this extent — not the unrotated span — before
 * stamping, or an off-axis decal spills onto a wall face or into the void.
 */
export function groundDecalHalfExtentPx(sizePx: number, rotationDeg: number): number {
  const rad = (rotationDeg * Math.PI) / 180;
  return (sizePx / 2) * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)));
}

/**
 * Stamp config for a ground decal. Mirrors `buildPoolStampConfig`'s center-origin
 * convention — signed scale and rotation act about the frame's own middle — so
 * callers must position the stamp at the footprint's CENTER, not its top-left
 * corner.
 */
export function buildGroundDecalStampConfig(
  scale: number,
  rotationDeg: number,
  flipX: boolean,
): { originX: number; originY: number; scaleX: number; scaleY: number; angle: number } {
  return {
    originX: 0.5,
    originY: 0.5,
    scaleX: (flipX ? -1 : 1) * scale,
    scaleY: scale,
    angle: rotationDeg,
  };
}

/**
 * Stamp config for one linework (2-edge Wang) tile.
 *
 * Deliberately has NO rotation and NO flip parameter, unlike the ground-decal
 * config. A Wang frame's identity is its edge signature; rotating or mirroring
 * it relabels those edges and silently breaks the join contract that makes a
 * run read as continuous. Orientation is already encoded in the 16-frame set,
 * so the renderer picks a frame and never transforms it.
 */
export function buildLineworkStampConfig(scale: number): {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
} {
  return { originX: 0.5, originY: 0.5, scaleX: scale, scaleY: scale };
}

/**
 * Decide whether an eligible linework tile carries a prop (switch stand, parked
 * cart, valve wheel).
 *
 * Keyed on the tile's own coordinates plus the layer salt, so the answer is
 * stable per tile and independent of iteration order — and two layers crossing
 * the same tile do not both drop a prop on it.
 */
export function shouldPlaceLineworkProp(
  floorSeed: number,
  seedSalt: string,
  tx: number,
  ty: number,
  density: number,
): boolean {
  if (density <= 0) return false;
  return new SeededRandom(deriveLineworkPropSeed(floorSeed, seedSalt, tx, ty)).next() < density;
}

/** Frame index for a placed prop. Uses a second draw off the same stream. */
export function pickLineworkPropFrame(
  floorSeed: number,
  seedSalt: string,
  tx: number,
  ty: number,
  frames: number,
  frameStart = 0,
): number {
  if (frames <= 0) return frameStart;
  const rng = new SeededRandom(deriveLineworkPropSeed(floorSeed, seedSalt, tx, ty));
  rng.next();
  return frameStart + Math.min(frames - 1, Math.floor(rng.next() * frames));
}

/**
 * Stamp config for a linework PROP.
 *
 * Unlike the Wang frames — whose identity IS their edge signature, so rotating
 * one relabels its edges and silently breaks the join contract — a prop carries
 * no edges. Turning it a quarter turn to follow an east-west run is therefore
 * both safe and necessary, otherwise every cart on a horizontal track sits
 * across the rails.
 */
export function buildLineworkPropStampConfig(
  scale: number,
  rotationRad: number,
): {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
} {
  return { originX: 0.5, originY: 0.5, scaleX: scale, scaleY: scale, rotation: rotationRad };
}

function deriveLineworkPropSeed(
  floorSeed: number,
  seedSalt: string,
  tx: number,
  ty: number,
): number {
  let saltHash = 0x811c9dc5;
  for (let i = 0; i < seedSalt.length; i++) {
    saltHash ^= seedSalt.charCodeAt(i);
    saltHash = Math.imul(saltHash, 0x01000193) >>> 0;
  }
  // Offset the coordinates so a prop draw can never coincide with the pool,
  // accent or decal pickers at the same integer tile.
  return deriveTileVariantSeed(floorSeed ^ saltHash, tx + 6151, ty + 2749);
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
