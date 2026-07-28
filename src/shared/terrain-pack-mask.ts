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
 * Diagonal gating rule: a diagonal bit only survives normalization if BOTH of
 * its adjacent cardinal bits are also set in the raw mask, e.g. NE survives
 * only when N and E are both set. This is the standard "blob47" rule (used by
 * RPG Maker / Godot-style 47-tile wall autotiling) and is what collapses 256
 * raw 8-neighbor combinations down to exactly 47 distinct canonical masks —
 * verified exhaustively in `tests/unit/terrain-pack-mask.test.ts`.
 *
 * Out-of-bounds neighbours are treated as non-matching (bit = 0), mirroring
 * the existing 4-directional `neighborMask()` in `tile-visuals.ts`.
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
 * Compute the raw 8-neighbor mask for tile (tx, ty), given a per-direction
 * match predicate. Out-of-bounds neighbours are treated as non-matching.
 *
 * `matches(nx, ny)` should return whether the neighbour tile at (nx, ny)
 * counts as "the same wall" for autotiling purposes — callers typically check
 * terrain-type equality (see `neighborMask8InTerrain` for the common case).
 */
export function computeRawMask8(
  tx: number,
  ty: number,
  width: number,
  height: number,
  matches: (nx: number, ny: number) => boolean,
): number {
  const inBounds = (nx: number, ny: number): boolean =>
    nx >= 0 && nx < width && ny >= 0 && ny < height;
  const at = (dx: number, dy: number): boolean => {
    const nx = tx + dx;
    const ny = ty + dy;
    return inBounds(nx, ny) && matches(nx, ny);
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
