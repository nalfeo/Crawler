/**
 * Terrain-pack 47-mask blob normalizer — single shared source of truth for how
 * an 8-neighbor raw mask (256 possibilities) collapses onto the canonical
 * 47-mask "blob47" wall autotile set.
 *
 * Both the runtime renderer (`src/engine/terrain-renderer.ts`) and the offline
 * pack assembler/validator (`scripts/sprites/terrain-packs/`) import this
 * module so the bit order, diagonal-gating rule, and canonical mask list can
 * never drift between build time and render time (reviewed-design refinement
 * #3).
 *
 * Bit order (pinned — do not renumber without updating every manifest):
 *   bit 0 (  1): N   bit 1 (  2): E   bit 2 (  4): S   bit 3 (  8): W
 *   bit 4 ( 16): NE  bit 5 ( 32): SE  bit 6 ( 64): SW  bit 7 (128): NW
 *
 * Relationship to the canonical cr31 numbering
 * --------------------------------------------
 * The reference blob47 literature (cr31 "Wang Blob", mirrored at
 * https://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html,
 * and every OpenGameArt blob tileset that follows it) weights the bits as a
 * CONTINUOUS CLOCKWISE CYCLE instead:
 *
 *   N=1  NE=2  E=4  SE=8  S=16  SW=32  W=64  NW=128
 *
 * Both weightings are bijections onto the same 47 shapes — only the *labels*
 * differ — so nothing about our geometry, gating, or packing is affected. But
 * the two numberings are NOT interchangeable: our mask 15 is not cr31's tile 15.
 * Any cross-reference against published blob47 tables, tools, or tilesets must
 * re-weight first (see `toCr31Index` in
 * `tests/unit/sprites/terrain-pack-corners.test.ts`).
 *
 * The cr31 ordering has one property ours lacks: rotating a tile 90 degrees
 * clockwise is exactly `index * 4 mod 255`. We do not currently rotate tiles at
 * build or render time, so this buys us nothing today; adopting it would be a
 * breaking migration of every manifest's `maskId` values and should be a
 * deliberate, separately-scoped decision rather than a silent change.
 *
 * Diagonal gating rule: a diagonal bit only survives normalization if BOTH of
 * its adjacent cardinal bits are also set in the raw mask, e.g. NE survives
 * only when N and E are both set. This is the standard "blob47" rule (used by
 * RPG Maker / Godot-style 47-tile wall autotiling) and is what collapses 256
 * raw 8-neighbor combinations down to exactly 47 distinct canonical masks —
 * verified exhaustively in `tests/unit/terrain-pack-mask.test.ts`.
 *
 * Out-of-bounds neighbours are treated as non-matching (bit = 0) by default,
 * mirroring the existing 4-directional `neighborMask()` in `tile-visuals.ts`.
 * `computeRawMask8`'s `outOfBoundsMatches` parameter can flip this per call
 * site — see its doc comment for why the wall-mask callers need `true`.
 */

/** Bit values for each of the 8 neighbour directions. Pinned — see module doc. */
export const MASK_BIT = {
  N: 1,
  E: 2,
  S: 4,
  W: 8,
  NE: 16,
  SE: 32,
  SW: 64,
  NW: 128,
} as const;

export type MaskDirection = keyof typeof MASK_BIT;

/** The four corner (diagonal) directions and their two adjacent cardinals. */
export const CORNER_ADJACENCY = {
  NE: ['N', 'E'],
  SE: ['S', 'E'],
  SW: ['S', 'W'],
  NW: ['N', 'W'],
} as const satisfies Record<string, readonly ['N' | 'S', 'E' | 'W']>;

/**
 * Normalize a raw 8-neighbor mask (0–255) to its canonical blob47 mask.
 *
 * Clears each diagonal bit unless BOTH of its adjacent cardinal bits are set
 * in the raw mask. Cardinal bits always pass through unchanged.
 *
 * Pure, deterministic, total over the full 0–255 input domain.
 */
export function normalizeBlob47Mask(raw: number): number {
  const cardinals = raw & (MASK_BIT.N | MASK_BIT.E | MASK_BIT.S | MASK_BIT.W);
  let mask = cardinals;
  if (raw & MASK_BIT.NE && cardinals & MASK_BIT.N && cardinals & MASK_BIT.E) {
    mask |= MASK_BIT.NE;
  }
  if (raw & MASK_BIT.SE && cardinals & MASK_BIT.S && cardinals & MASK_BIT.E) {
    mask |= MASK_BIT.SE;
  }
  if (raw & MASK_BIT.SW && cardinals & MASK_BIT.S && cardinals & MASK_BIT.W) {
    mask |= MASK_BIT.SW;
  }
  if (raw & MASK_BIT.NW && cardinals & MASK_BIT.N && cardinals & MASK_BIT.W) {
    mask |= MASK_BIT.NW;
  }
  return mask;
}

/** Compute the full set of distinct canonical masks over all 256 raw masks. */
function computeBlob47CanonicalMasks(): readonly number[] {
  const seen = new Set<number>();
  for (let raw = 0; raw < 256; raw++) {
    seen.add(normalizeBlob47Mask(raw));
  }
  return Object.freeze([...seen].sort((a, b) => a - b));
}

/**
 * The 47 canonical blob47 masks, in ascending numeric order. This ordering IS
 * the canonical ordering referenced by "canonical ordering" in the reviewed
 * design — pack manifests assign an explicit `frameIndex` per mask value
 * rather than relying on this array's index, but this array is what
 * `assertCompleteBlob47Coverage` checks manifests against.
 */
export const BLOB47_CANONICAL_MASKS: readonly number[] = computeBlob47CanonicalMasks();

/** Fails fast at module load if the gating rule above ever stops yielding 47. */
if (BLOB47_CANONICAL_MASKS.length !== 47) {
  throw new Error(
    `normalizeBlob47Mask invariant violated: expected 47 canonical masks, got ${BLOB47_CANONICAL_MASKS.length}`,
  );
}

const BLOB47_CANONICAL_SET: ReadonlySet<number> = new Set(BLOB47_CANONICAL_MASKS);

/** True when `mask` is one of the 47 canonical blob47 masks. */
export function isCanonicalBlob47Mask(mask: number): boolean {
  return BLOB47_CANONICAL_SET.has(mask);
}

/**
 * The one canonical blob47 mask whose wall frame covers its cell with no
 * transparency: all four cardinals AND all four diagonals present.
 *
 * This follows directly from the quadrant-kit geometry contract
 * (`scripts/sprites/terrain-packs/quadrant-kit.ts`), which every pack's wall
 * atlas is composed over:
 *
 *   - a quadrant is inset by `WALL_INSET_PX` off an OUTER edge whose cardinal
 *     is ABSENT, so any missing cardinal punches transparency into the cell;
 *   - a quadrant whose two cardinals are present but whose DIAGONAL is absent
 *     is `concave`, which bites a `CORNER_RADIUS_PX` notch out of its outer
 *     corner;
 *   - only the `full` state (both cardinals + the diagonal present) is solid.
 *
 * All four quadrants are therefore `full` — and the cell fully opaque — exactly
 * when every one of the eight neighbour bits is set, i.e. mask 255.
 *
 * `tests/unit/terrain-pack-frame-opacity.test.ts` proves this against the real
 * shipped atlas PNGs for every registered pack rather than trusting the
 * derivation, because `terrain-renderer.ts` uses it to SKIP the floor-pool
 * underdraw: if a supposedly-opaque frame ever gained a transparent pixel, the
 * empty RenderTexture (which reads as black) would show through.
 */
export const FULLY_OPAQUE_BLOB47_MASK = 255;

/**
 * Compute the raw 8-neighbor mask for tile (tx, ty), given a per-direction
 * match predicate.
 *
 * `matches(nx, ny)` should return whether the neighbour tile at (nx, ny)
 * counts as "the same wall" for autotiling purposes — callers typically check
 * terrain-type equality (see `neighborMask8InTerrain` for the common case).
 *
 * `outOfBoundsMatches` (default `false`) controls how a neighbour OUTSIDE the
 * map bounds is treated:
 *   - `false` (default): out-of-bounds counts as non-matching, i.e. "floor" —
 *     correct for same-terrain pool/corridor matching (`neighborMask8InTerrain`),
 *     where there is no terrain beyond the map to match against.
 *   - `true`: out-of-bounds counts as matching, i.e. "wall" — required for the
 *     pack wall-mask callers (`src/engine/terrain-renderer.ts`,
 *     `src/labs/terrain-pack-lab/index.ts`). A wall tile on the map edge has no
 *     real neighbour past the border; treating that missing neighbour as floor
 *     made the wall inset into nothing, exposing a floor-pool sliver past the
 *     map's edge. A wall should full-bleed against the edge exactly as it does
 *     against solid rock (see `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` in
 *     `terrain-renderer.ts` for the analogous in-bounds VOID/rock rule).
 */
function computeRawMask8(
  tx: number,
  ty: number,
  width: number,
  height: number,
  matches: (nx: number, ny: number) => boolean,
  outOfBoundsMatches = false,
): number {
  const inBounds = (nx: number, ny: number): boolean =>
    nx >= 0 && nx < width && ny >= 0 && ny < height;
  const at = (dx: number, dy: number): boolean => {
    const nx = tx + dx;
    const ny = ty + dy;
    return inBounds(nx, ny) ? matches(nx, ny) : outOfBoundsMatches;
  };
  let mask = 0;
  if (at(0, -1)) mask |= MASK_BIT.N;
  if (at(1, 0)) mask |= MASK_BIT.E;
  if (at(0, 1)) mask |= MASK_BIT.S;
  if (at(-1, 0)) mask |= MASK_BIT.W;
  if (at(1, -1)) mask |= MASK_BIT.NE;
  if (at(1, 1)) mask |= MASK_BIT.SE;
  if (at(-1, 1)) mask |= MASK_BIT.SW;
  if (at(-1, -1)) mask |= MASK_BIT.NW;
  return mask;
}

/**
 * Intentional non-production export for labs/tests that need the predicate-based
 * reference implementation. Runtime code should prefer `computeRawMask8Grid` or
 * `neighborMask8InTerrain`.
 */
export const _computeRawMask8 = computeRawMask8;

/**
 * Closure-free variant of {@link computeRawMask8} over a precomputed solidity
 * grid.
 *
 * `computeRawMask8` is a good general API but a poor hot-loop one: the caller
 * allocates a `matches` closure per tile, and the function allocates two more
 * (`inBounds`, `at`) per call, then dispatches eight indirect calls through
 * them. The terrain bake asks for a mask on every wall tile — over 23,000 on
 * Floor 1 — so that is ~70,000 short-lived closures and ~190,000 megamorphic
 * calls per bake to answer a question that is a single typed-array read.
 *
 * `solid[ny * width + nx]` must be non-zero exactly when the neighbour counts
 * as "solid" for autotiling. `outOfBoundsMatches` has the same meaning as in
 * `computeRawMask8`.
 *
 * `tests/unit/terrain-pack-mask.test.ts` asserts this agrees with
 * `computeRawMask8` exhaustively, so the bit order cannot drift between the
 * two implementations.
 */
export function computeRawMask8Grid(
  solid: Uint8Array,
  tx: number,
  ty: number,
  width: number,
  height: number,
  outOfBoundsMatches = false,
): number {
  const oob = outOfBoundsMatches ? 1 : 0;
  const n = ty > 0 ? solid[(ty - 1) * width + tx]! : oob;
  const s = ty < height - 1 ? solid[(ty + 1) * width + tx]! : oob;
  const w = tx > 0 ? solid[ty * width + tx - 1]! : oob;
  const e = tx < width - 1 ? solid[ty * width + tx + 1]! : oob;
  const nw = ty > 0 && tx > 0 ? solid[(ty - 1) * width + tx - 1]! : oob;
  const ne = ty > 0 && tx < width - 1 ? solid[(ty - 1) * width + tx + 1]! : oob;
  const sw = ty < height - 1 && tx > 0 ? solid[(ty + 1) * width + tx - 1]! : oob;
  const se = ty < height - 1 && tx < width - 1 ? solid[(ty + 1) * width + tx + 1]! : oob;
  let mask = 0;
  if (n) mask |= MASK_BIT.N;
  if (e) mask |= MASK_BIT.E;
  if (s) mask |= MASK_BIT.S;
  if (w) mask |= MASK_BIT.W;
  if (ne) mask |= MASK_BIT.NE;
  if (se) mask |= MASK_BIT.SE;
  if (sw) mask |= MASK_BIT.SW;
  if (nw) mask |= MASK_BIT.NW;
  return mask;
}

/**
 * Convenience: 8-neighbor mask over a flat row-major terrain array, matching
 * tiles equal to `matchTerrain`. Mirrors `neighborMask()` in `tile-visuals.ts`
 * (the 4-directional legacy path) but returns the full 8-bit raw mask before
 * blob47 gating — callers normalize with `normalizeBlob47Mask`.
 */
export function neighborMask8InTerrain(
  terrain: Uint8Array,
  width: number,
  height: number,
  tx: number,
  ty: number,
  matchTerrain: number,
): number {
  return computeRawMask8(
    tx,
    ty,
    width,
    height,
    (nx, ny) => terrain[ny * width + nx] === matchTerrain,
  );
}

/** Cardinal presence booleans decoded from a canonical (already-gated) mask. */
export interface EdgeConnections {
  readonly N: boolean;
  readonly E: boolean;
  readonly S: boolean;
  readonly W: boolean;
}

/** Decode the 4 cardinal bits of a mask into booleans. */
export function edgeConnectionsFromMask(mask: number): EdgeConnections {
  return {
    N: (mask & MASK_BIT.N) !== 0,
    E: (mask & MASK_BIT.E) !== 0,
    S: (mask & MASK_BIT.S) !== 0,
    W: (mask & MASK_BIT.W) !== 0,
  };
}

/**
 * The 5 possible local states of one quadrant (corner) of a blob47 wall cell,
 * derived from the two adjacent cardinal bits + the diagonal bit between them
 * (reviewed-design refinement: "20-quadrant kit" = 4 corners × 5 states).
 *
 *   'open'    — neither adjacent cardinal set: convex/outer corner, fully open.
 *   'edgeA'   — only the first adjacent cardinal set (see CORNER_ADJACENCY order).
 *   'edgeB'   — only the second adjacent cardinal set.
 *   'concave' — both cardinals set but the diagonal between them is NOT set:
 *               an inner-corner notch (the diagonal neighbour is missing even
 *               though both cardinal neighbours are present).
 *   'full'    — both cardinals AND the diagonal set: solid, no cut.
 */
export type QuadrantState = 'open' | 'edgeA' | 'edgeB' | 'concave' | 'full';

/** The 4 quadrant (corner) positions of a wall cell. */
export const QUADRANT_CORNERS = ['NW', 'NE', 'SE', 'SW'] as const;
export type QuadrantCorner = (typeof QUADRANT_CORNERS)[number];

/**
 * Classify one quadrant's local state from a canonical (gated) mask.
 *
 * `mask` MUST already be blob47-canonical (i.e. a diagonal bit is only set
 * when both its adjacent cardinals are set) — pass a raw mask through
 * `normalizeBlob47Mask` first. Given that precondition, the diagonal bit
 * alone distinguishes 'concave' from 'full' whenever both cardinals are set.
 */
export function quadrantStateFromMask(mask: number, corner: QuadrantCorner): QuadrantState {
  return quadrantStateFromMaskImpl(mask, corner);
}

/**
 * Whether the EXTREME OUTER CORNER of a blob47 wall cell is wall (true) or
 * floor (false) for one corner of a canonical mask.
 *
 * This is the corner-side counterpart to `edgeConnectionsFromMask` and is the
 * single shared definition of blob47 corner semantics — the pack validator's
 * corner-coverage check and the quadrant-kit compositor both derive from it so
 * the art and the gate can never disagree about what a corner should look like.
 *
 * The rule is exactly "the quadrant state is `full`":
 *   - `full`    (both cardinals AND the diagonal) → the corner is interior to a
 *               solid wall mass, so it is WALL.
 *   - `concave` (both cardinals, diagonal ABSENT) → the diagonal neighbour is
 *               floor, so the corner must be nicked out: FLOOR.
 *   - `edgeA` / `edgeB` (one cardinal) → the wall body is inset off the absent
 *               cardinal's edge, and the corner lies in that inset: FLOOR.
 *   - `open`    (neither cardinal) → convex outer corner: FLOOR.
 *
 * Exactly one canonical mask (255) therefore has all four corners wall.
 */
export function cornerIsWallFromMask(mask: number, corner: QuadrantCorner): boolean {
  return quadrantStateFromMaskImpl(mask, corner) === 'full';
}

function quadrantStateFromMaskImpl(mask: number, corner: QuadrantCorner): QuadrantState {
  const [cardA, cardB] = CORNER_ADJACENCY[corner];
  const bitA = MASK_BIT[cardA];
  const bitB = MASK_BIT[cardB];
  const bitDiag = MASK_BIT[corner];
  const hasA = (mask & bitA) !== 0;
  const hasB = (mask & bitB) !== 0;
  if (!hasA && !hasB) return 'open';
  if (hasA && !hasB) return 'edgeA';
  if (!hasA && hasB) return 'edgeB';
  // hasA && hasB
  return (mask & bitDiag) !== 0 ? 'full' : 'concave';
}

// --- Edge-matching ("2-edge") Wang tiles: the PATH counterpart of blob47 ---

/**
 * Blob47 above is a CORNER-matching Wang set, which is what makes it good at
 * terrain patches. Its sibling is the EDGE-matching set, which is what makes
 * paths and pipes: a tile's four edges are each either "path" or "blank", so a
 * complete set is 2^4 = 16 tiles, and neighbouring tiles agree exactly when the
 * shared edge has the same state on both sides.
 *
 * (Reference: cr31's Wang-tile pages — `wang/intro.html` "edge matching Wang
 * tiles tend to produce path or maze designs", `wang/2edge.html`, which ships a
 * PIPE tileset as its worked example, and `wang/shape.html`, whose rule that a
 * tile is "never extended to cover any neighboring tile" is the join contract
 * encoded by `EdgeWangStubContract` below.)
 *
 * Those 16 masks are exactly the segment vocabulary a linework run needs:
 *
 *   popcount 0 → 1 empty tile
 *   popcount 1 → 4 end-caps      (N / E / S / W)
 *   popcount 2 → 2 straights + 4 corners
 *   popcount 3 → 4 T-junctions
 *   popcount 4 → 1 cross
 *
 * so the renderer never carries an orientation: it derives the 4-bit mask from
 * neighbouring occupancy and uses it DIRECTLY as the frame index. That identity
 * (`frameIndex === maskId`) is why an edge-Wang atlas needs no `masks` table,
 * unlike `wallAutotile`.
 *
 * Bit order is the SAME as `MASK_BIT` (N=1, E=2, S=4, W=8) so the two families
 * can never disagree about what "north" means.
 */
export const EDGE_WANG_FRAME_COUNT = 16;

/** The 4 cardinal directions in edge-Wang bit order, with their tile deltas. */
export const EDGE_WANG_DIRECTIONS = [
  { dir: 'N', bit: MASK_BIT.N, dx: 0, dy: -1 },
  { dir: 'E', bit: MASK_BIT.E, dx: 1, dy: 0 },
  { dir: 'S', bit: MASK_BIT.S, dx: 0, dy: 1 },
  { dir: 'W', bit: MASK_BIT.W, dx: -1, dy: 0 },
] as const satisfies ReadonlyArray<{
  dir: 'N' | 'E' | 'S' | 'W';
  bit: number;
  dx: number;
  dy: number;
}>;

/** The opposite direction bit — the edge a neighbour shares with this tile. */
export const EDGE_WANG_OPPOSITE_BIT: Readonly<Record<'N' | 'E' | 'S' | 'W', number>> = {
  N: MASK_BIT.S,
  E: MASK_BIT.W,
  S: MASK_BIT.N,
  W: MASK_BIT.E,
};

/**
 * Derive a tile's 4-bit edge-Wang mask from a flat row-major occupancy grid
 * (non-zero = this tile carries the run). Out-of-bounds neighbours are
 * unoccupied, so a run reaching the map border ends in an end-cap rather than
 * pointing at nothing.
 */
export function edgeWangMaskFromOccupancy(
  occupancy: Uint8Array,
  width: number,
  height: number,
  tx: number,
  ty: number,
): number {
  let mask = 0;
  for (const { bit, dx, dy } of EDGE_WANG_DIRECTIONS) {
    const nx = tx + dx;
    const ny = ty + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (occupancy[ny * width + nx]) mask |= bit;
  }
  return mask;
}

/**
 * The join contract, in the form the derivation enforces and the committed-art
 * guard checks.
 *
 * Every frame whose mask has direction D set must present the SAME stub on
 * edge D: pixels in `[offsetPx, offsetPx + widthPx)` along that edge are opaque
 * and every other pixel on that edge is transparent. Two neighbouring tiles
 * whose masks agree therefore butt together with no gap and no overlap, by
 * construction — coherence is structural, not a tuning knob.
 *
 * The offset is measured left-to-right for the N/S edges and top-to-bottom for
 * the E/W edges, so a single (offset, width) pair describes all four edges of a
 * square cell.
 */
export interface EdgeWangStubContract {
  readonly cellPx: number;
  readonly offsetPx: number;
  readonly widthPx: number;
}

/** Inclusive-exclusive pixel span of the stub along any edge. */
export function edgeWangStubSpan(contract: EdgeWangStubContract): {
  readonly start: number;
  readonly end: number;
} {
  return { start: contract.offsetPx, end: contract.offsetPx + contract.widthPx };
}
