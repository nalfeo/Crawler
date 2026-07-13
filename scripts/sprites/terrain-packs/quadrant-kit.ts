/**
 * Deterministic procedural quadrant-kit generator for the authored
 * "industrial-cave" terrain pack.
 *
 * Produces the 20-quadrant kit (4 corners × 5 local states, reviewed-design
 * refinement) as pure in-memory RGBA images — original, geometrically
 * generated art (no external assets), so composing them for all 47 canonical
 * blob47 masks is provably edge-compatible by construction: whether a
 * quadrant paints wall pixels along a given cell edge is a direct function of
 * whether the corresponding cardinal bit is set, never of the diagonal bit
 * alone (see `QUADRANT_EDGE_BAND_PX` below).
 */
import type { QuadrantCorner, QuadrantState } from '../../../src/shared/terrain-pack-mask.js';
import { QUADRANT_CORNERS } from '../../../src/shared/terrain-pack-mask.js';
import { createImage, fillRect, type RgbaImage } from './png-buffer.js';

/** Source quadrant size in px — 4 quadrants of this size compose one 256x256 wall cell. */
export const QUADRANT_SRC_PX = 128;

/** Thickness (px) of the near-edge wall strip within a quadrant. Exactly half — see module doc. */
const EDGE_BAND_PX = QUADRANT_SRC_PX / 2;

/** Industrial-cave wall color (opaque dark rock). Deterministic, original palette choice. */
const WALL_COLOR: readonly [number, number, number, number] = [58, 56, 64, 255];
/** Slightly lighter accent used for the innermost solid block, for visual depth (not semantic). */
const WALL_ACCENT_COLOR: readonly [number, number, number, number] = [72, 70, 80, 255];

/**
 * All 5 states for a given corner, as (edgeABandRect, edgeBBandRect, innerCornerRect) predicates
 * expressed in LOCAL quadrant coordinates. `near*` describes which half of the local axis is
 * "near" that corner's cardinal edge — this varies per corner (see module doc derivation).
 */
interface QuadrantGeometry {
  /** True if local x in [0, EDGE_BAND_PX) is "near" the cardB (vertical/W-or-E) edge. */
  readonly nearLeftIsEdgeB: boolean;
  /** True if local y in [0, EDGE_BAND_PX) is "near" the cardA (horizontal/N-or-S) edge. */
  readonly nearTopIsEdgeA: boolean;
}

const QUADRANT_GEOMETRY: Record<QuadrantCorner, QuadrantGeometry> = {
  // NW quadrant: cardA=N (near top), cardB=W (near left).
  NW: { nearLeftIsEdgeB: true, nearTopIsEdgeA: true },
  // NE quadrant: cardA=N (near top), cardB=E (near right, i.e. NOT "near left").
  NE: { nearLeftIsEdgeB: false, nearTopIsEdgeA: true },
  // SE quadrant: cardA=S (near bottom, i.e. NOT "near top"), cardB=E (near right).
  SE: { nearLeftIsEdgeB: false, nearTopIsEdgeA: false },
  // SW quadrant: cardA=S (near bottom), cardB=W (near left).
  SW: { nearLeftIsEdgeB: true, nearTopIsEdgeA: false },
};

/**
 * Render one quadrant's RGBA image for a given corner + local state.
 *
 * Geometry rule (deterministic, documented): the cardA edge contributes a
 * full-span band of thickness EDGE_BAND_PX along its near side IF cardA is
 * present in this state; likewise for cardB. The remaining "inner corner"
 * sub-square is filled only when BOTH cardinals are present AND the diagonal
 * is present (state 'full'); left empty for 'concave'. This guarantees any
 * cell edge's wall/no-wall coverage depends only on the corresponding
 * cardinal bit, which is what the compatible-boundary validator checks.
 */
function renderQuadrant(corner: QuadrantCorner, state: QuadrantState): RgbaImage {
  const img = createImage(QUADRANT_SRC_PX, QUADRANT_SRC_PX);
  const geom = QUADRANT_GEOMETRY[corner];
  // 'edgeA'/'edgeB' each mean exactly one adjacent cardinal — normalize per corner naming:
  // CORNER_ADJACENCY[corner] = [cardA, cardB]; edgeA state => cardA present only.
  const cardAPresent = state === 'edgeA' || state === 'concave' || state === 'full';
  const cardBPresent = state === 'edgeB' || state === 'concave' || state === 'full';

  const [r, g, b, a] = WALL_COLOR;
  if (cardAPresent) {
    const y0 = geom.nearTopIsEdgeA ? 0 : QUADRANT_SRC_PX - EDGE_BAND_PX;
    fillRect(img, 0, y0, QUADRANT_SRC_PX, EDGE_BAND_PX, r, g, b, a);
  }
  if (cardBPresent) {
    const x0 = geom.nearLeftIsEdgeB ? 0 : QUADRANT_SRC_PX - EDGE_BAND_PX;
    fillRect(img, x0, 0, EDGE_BAND_PX, QUADRANT_SRC_PX, r, g, b, a);
  }
  if (state === 'full' || state === 'open') {
    // Inner corner sub-square: the remaining quadrant-diagonal corner opposite this corner's
    // cardinal-near sides. Filling it with the accent color completes full coverage while
    // giving a (non-semantic) visual depth cue distinguishing it from the edge-band fill.
    // In the `open` state, this keeps isolated-mask cells visibly solid at the center
    // without painting any cardinal edge band, so edge-compatibility semantics remain intact.
    const x0 = geom.nearLeftIsEdgeB ? EDGE_BAND_PX : 0;
    const y0 = geom.nearTopIsEdgeA ? EDGE_BAND_PX : 0;
    const [ar, ag, ab, aa] = WALL_ACCENT_COLOR;
    fillRect(img, x0, y0, EDGE_BAND_PX, EDGE_BAND_PX, ar, ag, ab, aa);
  }
  return img;
}

/** Generate the full 20-quadrant kit: all 4 corners × all 5 states. */
export function generateQuadrantKit(): ReadonlyMap<string, RgbaImage> {
  const kit = new Map<string, RgbaImage>();
  const states: readonly QuadrantState[] = ['open', 'edgeA', 'edgeB', 'concave', 'full'];
  for (const corner of QUADRANT_CORNERS) {
    for (const state of states) {
      kit.set(quadrantKitKey(corner, state), renderQuadrant(corner, state));
    }
  }
  return kit;
}

export function quadrantKitKey(corner: QuadrantCorner, state: QuadrantState): string {
  return `${corner}:${state}`;
}
