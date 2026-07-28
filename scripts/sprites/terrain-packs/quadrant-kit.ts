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
 * alone (see `WALL_INSET_PX` below).
 *
 * Silhouette model (crenellation fix): each quadrant fills a SINGLE solid
 * rectangle. The wall reaches fully to an OUTER edge whose cardinal is present
 * (a seamless shared boundary with the connected neighbour wall) and is pulled
 * in by a uniform `WALL_INSET_PX` off an OUTER edge whose cardinal is absent
 * (floor on that side). A straight wall→floor boundary is therefore one clean
 * inset line across the whole run, not the per-cell strip-and-gap crenellation
 * the earlier edge-band geometry produced. INNER (cell-centre-facing) edges are
 * never inset, so the four quadrants always compose into one solid wall body.
 */
import type { QuadrantCorner, QuadrantState } from '../../../src/shared/terrain-pack-mask.js';
import { QUADRANT_CORNERS } from '../../../src/shared/terrain-pack-mask.js';
import {
  createImage,
  eraseQuarterDisc,
  fillRect,
  roundConvexCorner,
  type RgbaImage,
} from './png-buffer.js';

/** Source quadrant size in px — 4 quadrants of this size compose one 256x256 wall cell. */
export const QUADRANT_SRC_PX = 128;

/**
 * Uniform inset (px, in quadrant/cell space — a quadrant pastes 1:1 into the
 * 256px cell) pulled in from a quadrant's OUTER edge when the corresponding
 * cardinal is ABSENT (floor, not wall, on that side).
 *
 * Chosen ≥ the authored edge-sample band thickness the validator uses
 * (`AUTHORED_EDGE_SAMPLING.bandThicknessFraction * 256 = 38.4px`, see
 * `edge-signature.ts`), so an absent cardinal's sampled edge band is entirely
 * within the transparent inset and a present cardinal's edge is entirely wall.
 * That is what keeps the compatible-boundary check provably 100% for this
 * authored pack: an edge classifies "solid" iff its cardinal bit is set, never
 * as a function of the diagonal or the perpendicular cardinal.
 */
const WALL_INSET_PX = 48;

/** Industrial-cave wall color (opaque dark rock). Deterministic, original palette choice. */
const WALL_COLOR: readonly [number, number, number, number] = [58, 56, 64, 255];

/**
 * Corner rounding radius (px, cell space) applied to exposed wall corners.
 *
 * Caves are eroded, not cut, so their silhouettes should have no sharp
 * 90-degree corners. Equal to `WALL_INSET_PX` so a convex corner rounds across
 * exactly the inset it sits on — the wall meets the floor tangentially instead
 * of stepping — and so a `concave` bite reaches the full depth of the notch it
 * replaces.
 *
 * CRITICAL — why this value is safe for both validator gates. All rounding is
 * confined to a `WALL_INSET_PX`-sized square at a cell corner, i.e. the outer
 * 48/256 = 18.75% of each axis:
 *
 *  - Cardinal edge gate: `AUTHORED_EDGE_SAMPLING.marginFraction` is 0.25, so the
 *    sampled span along any edge is [64, 192] of 256. The `concave` bite lives
 *    in [0, 48]; the `open` round lives in [48, 96] but only on the axis facing
 *    INTO the cell, never within the 38.4px edge band. Neither reaches a
 *    sampled band.
 *  - Corner coverage gate: `AUTHORED_CORNER_SAMPLING.sampleFraction` is 0.09, so
 *    the sample square is the outer ~23px at the cell corner. `concave` must
 *    read floor there and the r=48 bite covers [0, 23] entirely (max distance
 *    from the corner is 23*sqrt(2) = 32.5 < 48). `open` already reads floor
 *    there and the round never touches it. `full` — the one state whose corner
 *    must read wall — is not rounded at all.
 *
 * Both properties are asserted, not assumed: see
 * `tests/unit/sprites/terrain-pack-corners.test.ts`.
 */
const CORNER_RADIUS_PX = WALL_INSET_PX;

/**
 * Per-corner geometry: which local edges are the OUTER (cardinal-facing) edges,
 * expressed in LOCAL quadrant coordinates. `near*` describes which half of the
 * local axis is "near" that corner's cardinal edge — this varies per corner
 * (see module doc derivation). The opposite side of each axis is the INNER,
 * cell-centre-facing edge, which is never inset.
 */
interface QuadrantGeometry {
  /** True if the cardB (vertical/W-or-E) OUTER edge is the local left (x=0) side. */
  readonly nearLeftIsEdgeB: boolean;
  /** True if the cardA (horizontal/N-or-S) OUTER edge is the local top (y=0) side. */
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
 * Geometry rule (deterministic, documented). Each quadrant covers one corner
 * of the 256x256 cell; its two OUTER edges are the cell's cardA (N/S) and cardB
 * (W/E) edges, its two INNER edges face the cell centre and always butt flush
 * against the adjacent quadrants. We fill a SINGLE solid rectangle:
 *   - OUTER edge, cardinal PRESENT → wall reaches fully to that edge (seamless
 *     shared boundary with the connected neighbour wall cell).
 *   - OUTER edge, cardinal ABSENT (floor) → wall inset by `WALL_INSET_PX`, so a
 *     straight wall→floor boundary is one clean inset line, never crenellated.
 *   - INNER edges → never inset, so the four quadrants compose into one solid
 *     wall body with no interior seam.
 * The `open` state (neither cardinal present — a convex outer corner, or an
 * isolated cell) is thus inset on BOTH outer edges: convex corners are bevelled
 * and an isolated wall still renders a visible centre block.
 *
 * `concave` (both cardinals present, diagonal ABSENT): both outer edges reach
 * their cell boundary — same as `full` along the edges — but a quarter-disc of
 * radius `CORNER_RADIUS_PX` is bitten out of the OUTER corner (the corner facing
 * the missing diagonal neighbour). That is the defining visual of a blob47 inner
 * corner: the diagonal cell is floor, so the wall must be nicked back there.
 *
 * Corner rounding. Caves are eroded, not cut, so no exposed corner is left at
 * 90 degrees:
 *   - `concave` → the notch is a quarter-disc bite, so the wall sweeps around
 *     the floor poking in at the diagonal.
 *   - `open` → the two inset lines meet at a genuine convex corner inside this
 *     cell; it is rounded tangent to both insets.
 *   - `edgeA` / `edgeB` → deliberately NOT rounded. Exactly one cardinal is
 *     wall, so the single inset line runs straight on into the connected
 *     neighbour's matching quadrant. There is no corner to round, and rounding
 *     there would pinch the wall at every wall-to-wall seam.
 *   - `full` → solid, nothing to round.
 *
 * All rounding is confined to a `WALL_INSET_PX` square at the cell corner, i.e.
 * the outer 18.75% of each axis, which sits entirely inside
 * `AUTHORED_EDGE_SAMPLING`'s 25% corner-exclusion margin (sampled edge span is
 * [64, 192] of 256). The cardinal-edge compatibility invariant is therefore
 * preserved (still provably 100%) while the corner now carries the diagonal
 * information the corner-coverage validator checks.
 *
 * Because "present cardinal → wall reaches that edge; absent cardinal → inset
 * off it" holds independently per cardinal, each cell edge's wall/no-wall
 * coverage depends only on the corresponding cardinal bit — exactly the
 * invariant the compatible-boundary validator asserts (provably 100% here).
 */
function renderQuadrant(corner: QuadrantCorner, state: QuadrantState): RgbaImage {
  const img = createImage(QUADRANT_SRC_PX, QUADRANT_SRC_PX);
  const geom = QUADRANT_GEOMETRY[corner];
  const cardAPresent = state === 'edgeA' || state === 'concave' || state === 'full';
  const cardBPresent = state === 'edgeB' || state === 'concave' || state === 'full';

  // cardA is the horizontal (N/S) edge: its outer side is the local top (when
  // nearTopIsEdgeA) or the local bottom; the opposite side is inner (flush).
  const top = geom.nearTopIsEdgeA && !cardAPresent ? WALL_INSET_PX : 0;
  const bottom =
    !geom.nearTopIsEdgeA && !cardAPresent ? QUADRANT_SRC_PX - WALL_INSET_PX : QUADRANT_SRC_PX;
  // cardB is the vertical (W/E) edge: its outer side is the local left (when
  // nearLeftIsEdgeB) or the local right; the opposite side is inner (flush).
  const left = geom.nearLeftIsEdgeB && !cardBPresent ? WALL_INSET_PX : 0;
  const right =
    !geom.nearLeftIsEdgeB && !cardBPresent ? QUADRANT_SRC_PX - WALL_INSET_PX : QUADRANT_SRC_PX;

  const [r, g, b, a] = WALL_COLOR;
  fillRect(img, left, top, right - left, bottom - top, r, g, b, a);

  // Local coordinates of this quadrant's OUTER corner (the cell corner) and the
  // inward direction from it. Every rounding operation below is expressed
  // relative to these so the four corners share one code path.
  const outerX = geom.nearLeftIsEdgeB ? 0 : QUADRANT_SRC_PX;
  const outerY = geom.nearTopIsEdgeA ? 0 : QUADRANT_SRC_PX;
  const inX: -1 | 1 = geom.nearLeftIsEdgeB ? 1 : -1;
  const inY: -1 | 1 = geom.nearTopIsEdgeA ? 1 : -1;

  if (state === 'concave') {
    // Both cardinals present (wall reaches both outer edges) but the diagonal is
    // ABSENT → bite a rounded notch out of the OUTER corner (the corner facing
    // the missing diagonal neighbour). This is what makes an inner corner read
    // as an inner corner instead of flat wall, and is what `cornerIsWallFromMask`
    // / the corner-coverage validator assert.
    //
    // The bite is a quarter-disc rather than a square so the wall sweeps around
    // the floor that pokes in at the diagonal — an eroded scoop, which is the
    // whole point of a cave silhouette.
    eraseQuarterDisc(img, outerX, outerY, CORNER_RADIUS_PX, inX, inY);
  } else if (!cardAPresent && !cardBPresent) {
    // 'open': inset off BOTH outer edges, so the two inset lines meet at a real
    // convex corner INSIDE this cell. Round it.
    //
    // This is the only state with an exposed convex corner. In 'edgeA'/'edgeB'
    // exactly one cardinal is wall, so the single inset line runs straight on
    // into the connected neighbour's matching quadrant — there is no corner
    // there, and rounding one would pinch the wall at every wall-to-wall seam.
    // 'full' is solid.
    roundConvexCorner(
      img,
      outerX + inX * WALL_INSET_PX,
      outerY + inY * WALL_INSET_PX,
      CORNER_RADIUS_PX,
      inX,
      inY,
    );
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
