/**
 * Deterministic GEOMETRY for the Floor 2 industrial linework atlases.
 *
 * This file computes, for each of the 16 edge-Wang masks, which pixels of a
 * 64x64 cell are rail head / sleeper / pipe wall / collar. It draws no texture
 * whatsoever — the colour of every one of those pixels is sampled from a
 * generated Azure material by the importer. That split is the session's
 * governing law: generated art supplies texture, local deterministic code
 * supplies geometry, pooling, lighting and validation.
 *
 * WHY GEOMETRY IS LOCAL AND NOT GENERATED. The whole point of a 2-edge Wang set
 * is that a tile's art stops at its own square and still meets its neighbour
 * exactly (cr31: "the Wang tile designs remain square and are never extended to
 * cover any neighboring tile", and the edges must "fit snugly together, without
 * overlap or gaps"). A generator cannot promise that; a rasteriser can, and
 * does, by construction:
 *
 *   Every centreline meets its cell edge PERPENDICULARLY at the edge midpoint.
 *
 * Straights meet it perpendicularly because they are axis-aligned. Corners meet
 * it perpendicularly because the arc is centred on the cell CORNER with radius
 * exactly half the cell, so at the edge midpoint the radius is parallel to the
 * edge and the tangent is normal to it. Rails/bores are defined purely as a
 * function of perpendicular distance to the centreline, so at any connected edge
 * every frame paints the identical boundary profile — and sleepers and collars
 * are phased so they never touch a boundary row at all. Two neighbours whose
 * masks agree therefore join with no seam, for every one of the 16 x 16 possible
 * adjacencies. The committed-art guard asserts this pixel-for-pixel rather than
 * trusting the argument.
 */

/** One cell of every linework atlas. Matches `TERRAIN_PACK_CELL_PX`. */
export const LINEWORK_CELL_PX = 64;

/** Bit order must match `MASK_BIT` / `EDGE_WANG_DIRECTIONS` in `terrain-pack-mask.ts`. */
const BIT_N = 1;
const BIT_E = 2;
const BIT_S = 4;
const BIT_W = 8;

const HALF = LINEWORK_CELL_PX / 2;

/** What a pixel is, which decides which material it samples and how it is lit. */
export const LINEWORK_PIXEL = {
  Empty: 0,
  /** Rail head (track) or pipe wall (pipe) — the highlighted running surface. */
  Rail: 1,
  /** Sleeper (track) or collar/flange (pipe) — the cross-member. */
  Tie: 2,
  /** Terminal hardware: buffer stop or ground flange. */
  Cap: 3,
} as const;
export type LineworkPixel = (typeof LINEWORK_PIXEL)[keyof typeof LINEWORK_PIXEL];

/** A centreline through the cell, expressed so distance queries are exact. */
type Curve =
  | {
      readonly kind: 'line';
      /** Unit direction of travel. */
      readonly ux: number;
      readonly uy: number;
      /** A point on the centreline. */
      readonly px: number;
      readonly py: number;
      /** Arc-length window, measured from the connected edge inward. */
      readonly alongMax: number;
    }
  | {
      readonly kind: 'arc';
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      /** Quadrant selector: the arc only exists where these signs hold. */
      readonly signX: number;
      readonly signY: number;
    };

/**
 * Perpendicular offset and arc-length for a pixel against one curve, or `null`
 * when the pixel is outside the curve's own span.
 *
 * `along` is measured from the connected edge so half-length stubs (end caps and
 * the third leg of a T) can be clipped, and so cross-member phase is anchored to
 * the edge — which is what keeps ties off the boundary rows.
 */
function project(
  curve: Curve,
  x: number,
  y: number,
): { off: number; along: number; dx: number; dy: number } | null {
  if (curve.kind === 'line') {
    const dx = x - curve.px;
    const dy = y - curve.py;
    const along = dx * curve.ux + dy * curve.uy;
    if (along < 0 || along > curve.alongMax) return null;
    return {
      off: dx * -curve.uy + dy * curve.ux,
      along,
      // Displacement from the closest centreline point to the pixel, in cell
      // space. Needed because `off`'s SIGN is curve-relative: a straight entered
      // from N and one entered from W disagree about which side is positive, so
      // shading off `off` alone lights vertical and horizontal runs from
      // opposite directions. Screen-space displacement has no such ambiguity.
      dx: dx - along * curve.ux,
      dy: dy - along * curve.uy,
    };
  }
  const dx = x - curve.cx;
  const dy = y - curve.cy;
  if (dx * curve.signX < 0 || dy * curve.signY < 0) return null;
  const r = Math.hypot(dx, dy);
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  const scale = r === 0 ? 0 : 1 - curve.radius / r;
  return { off: r - curve.radius, along: curve.radius * angle, dx: dx * scale, dy: dy * scale };
}

/** Half-length stub from one edge to the cell centre. */
function stubCurve(bit: number): Curve {
  switch (bit) {
    case BIT_N:
      return { kind: 'line', ux: 0, uy: 1, px: HALF, py: 0, alongMax: HALF };
    case BIT_S:
      return { kind: 'line', ux: 0, uy: -1, px: HALF, py: LINEWORK_CELL_PX, alongMax: HALF };
    case BIT_W:
      return { kind: 'line', ux: 1, uy: 0, px: 0, py: HALF, alongMax: HALF };
    default:
      return { kind: 'line', ux: -1, uy: 0, px: LINEWORK_CELL_PX, py: HALF, alongMax: HALF };
  }
}

/** Full-length straight across the cell, entered from `bit`. */
function straightCurve(bit: number): Curve {
  const stub = stubCurve(bit) as Extract<Curve, { kind: 'line' }>;
  return { ...stub, alongMax: LINEWORK_CELL_PX };
}

/**
 * Stub extended past the cell centre so terminal hardware can be projected.
 * Used ONLY to classify `Cap` pixels on end-cap masks; rails and ties keep the
 * HALF-limited `stubCurve`, so this cannot alter any connected edge's profile.
 */
function capCurve(bit: number): Curve {
  const stub = stubCurve(bit) as Extract<Curve, { kind: 'line' }>;
  return { ...stub, alongMax: HALF + CAP_REACH };
}

/**
 * Quarter arc joining two adjacent edge midpoints, centred on the cell corner
 * between them with radius `HALF`. This is the only corner geometry that leaves
 * the boundary profile identical to a straight's — see the file header.
 */
function cornerCurve(mask: number): Curve {
  const north = (mask & BIT_N) !== 0;
  const west = (mask & BIT_W) !== 0;
  const cx = west ? 0 : LINEWORK_CELL_PX;
  const cy = north ? 0 : LINEWORK_CELL_PX;
  return {
    kind: 'arc',
    cx,
    cy,
    radius: HALF,
    signX: west ? 1 : -1,
    signY: north ? 1 : -1,
  };
}

/** The centrelines that make up one mask's art. */
function curvesForMask(mask: number): readonly Curve[] {
  const bits = [BIT_N, BIT_E, BIT_S, BIT_W].filter((b) => (mask & b) !== 0);
  if (bits.length === 0) return [];
  if (bits.length === 1) return [stubCurve(bits[0] as number)];
  if (bits.length === 2) {
    const hasN = (mask & BIT_N) !== 0;
    const hasS = (mask & BIT_S) !== 0;
    // Opposite pairs are exactly N+S and E+W; both leave N and S agreeing.
    const opposed = hasN === hasS;
    if (!opposed) return [cornerCurve(mask)];
    // `bits[0]` picks the entry edge; either end of a straight is equivalent.
    return [straightCurve(bits[0] as number)];
  }
  if (bits.length === 3) {
    // A turnout: the straight through the opposed pair, plus a stub for the third.
    const throughBit = (mask & BIT_N) !== 0 && (mask & BIT_S) !== 0 ? BIT_N : BIT_E;
    const spurBit = bits.find((b) => b !== throughBit && b !== oppositeBit(throughBit)) as number;
    return [straightCurve(throughBit), stubCurve(spurBit)];
  }
  return [straightCurve(BIT_N), straightCurve(BIT_E)];
}

function oppositeBit(bit: number): number {
  if (bit === BIT_N) return BIT_S;
  if (bit === BIT_S) return BIT_N;
  if (bit === BIT_E) return BIT_W;
  return BIT_E;
}

/** Tunable cross-section of one linework kind. */
export interface LineworkProfile {
  /** Distance from centreline to each rail head; 0 for a single-body pipe. */
  readonly railOffset: number;
  /** Half-width of a rail head, or half the bore for a pipe. */
  readonly railHalfWidth: number;
  /** Half-length of a cross-member measured from the centreline. */
  readonly tieHalfLength: number;
  /** Half-width of a cross-member along the run. */
  readonly tieHalfWidth: number;
  /** Arc-length period of cross-members. Must divide the cell size evenly. */
  readonly tiePeriod: number;
  /** Arc-length phase of the first cross-member from the connected edge. */
  readonly tiePhase: number;
  /**
   * Arc-length offset of each ring in a PAIRED cross-member, or 0 for a single
   * band. A pipe reads as pressure plumbing when its collars are rivet-band
   * pairs rather than lone rings, and doubling the ring count is the cheapest
   * honest way to add the "more rivet bands" the human asked for without
   * shrinking the period so far that bands collide with the edge clearance.
   */
  readonly tieDoubleGap: number;
  /** Half-length of the terminal buffer stop / ground flange. */
  readonly capHalfLength: number;
  /** Half-width of the terminal hardware along the run. */
  readonly capHalfWidth: number;
}

/**
 * How far past the cell centre terminal hardware may reach.
 *
 * Cap geometry needs its OWN curve. `stubCurve` stops at `alongMax = HALF`, so
 * `project()` returns null for every pixel past the cell centre — which meant
 * the original cap test `|along - HALF| <= capHalfWidth` only ever painted the
 * near half of its beam, and any buttress behind that beam was silently
 * discarded. Rails and ties keep the HALF-limited stub, so widening the cap
 * reach cannot change what a connected edge paints.
 */
const CAP_REACH = 12;

/** Half-length of a buffer-stop buttress measured inward from `capHalfLength`. */
const BUTTRESS_DEPTH = 7;

/** Arc length of a buffer-stop buttress behind the beam. */
const BUTTRESS_LENGTH = 7;

/** Skips the centreline pass when terminal hardware already claimed a pixel. */
const EMPTY_CURVES: readonly Curve[] = [];

/** Mine-cart track: two rail heads on periodic sleepers. */
export const TRACK_PROFILE: LineworkProfile = {
  railOffset: 11,
  railHalfWidth: 3,
  tieHalfLength: 17,
  tieHalfWidth: 3.5,
  tiePeriod: 16,
  tiePhase: 8,
  tieDoubleGap: 0,
  capHalfLength: 15,
  capHalfWidth: 5,
};

/** Pipe run: one bore with periodic rivet-band pairs. */
export const PIPE_PROFILE: LineworkProfile = {
  railOffset: 0,
  railHalfWidth: 9,
  // The ring must clear the bore by enough pixels to survive the 0.5 atlas
  // downscale — at `tieHalfLength: 12` the shoulders protruded 3 atlas px, which
  // is ~2 screen px and reads as texture rather than hardware.
  tieHalfLength: 14,
  tieHalfWidth: 2.4,
  tiePeriod: 32,
  tiePhase: 16,
  // Rings sit at arc-length 11/21 and 43/53 of a 64-long straight — four bands
  // per cell instead of two, every one of them clear of `TIE_EDGE_CLEARANCE`.
  tieDoubleGap: 5,
  capHalfLength: 13,
  capHalfWidth: 3,
};

/**
 * Bounding span of the opaque profile on a connected edge.
 *
 * Recorded in the manifest so the committed-art guard can assert that no frame
 * paints outside the declared stub, which is what stops a future art change from
 * silently widening a rail and breaking every join.
 */
export function stubSpan(profile: LineworkProfile): { offsetPx: number; widthPx: number } {
  const half = profile.railOffset + profile.railHalfWidth;
  const offsetPx = Math.floor(HALF - half);
  return { offsetPx, widthPx: Math.ceil(HALF + half) - offsetPx };
}

/** Arc length of a curve, used to keep cross-members off the boundary rows. */
function curveLength(curve: Curve): number {
  return curve.kind === 'line' ? curve.alongMax : (curve.radius * Math.PI) / 2;
}

/**
 * Minimum arc-length gap between any cross-member and either end of its curve.
 *
 * This is what makes the stub contract hold for EVERY frame rather than only for
 * the ones where the periodic phase happens to land clear of the edge. Without
 * it a pipe collar lands on the last row of the corner frame (the quarter arc is
 * 50.27 long, not a multiple of the collar period) and that one frame paints a
 * boundary profile no straight can match.
 */
const TIE_EDGE_CLEARANCE = 4;

function isRail(off: number, profile: LineworkProfile): boolean {
  return Math.abs(Math.abs(off) - profile.railOffset) <= profile.railHalfWidth;
}

/** Arc-length position within one cross-member period. */
function ringPhase(along: number, profile: LineworkProfile): number {
  return (((along - profile.tiePhase) % profile.tiePeriod) + profile.tiePeriod) % profile.tiePeriod;
}

/**
 * Signed arc-length distance from the nearest ring of a cross-member.
 *
 * With `tieDoubleGap === 0` this is the distance from the collar centre, i.e.
 * the original single-band behaviour. With a positive gap the collar becomes a
 * PAIR of rings straddling that centre, which is how a pipe gets twice the rivet
 * bands without halving the period into the edge-clearance zone.
 */
function ringOffset(along: number, profile: LineworkProfile): number {
  const phase = ringPhase(along, profile);
  const centred = Math.min(phase, profile.tiePeriod - phase);
  return centred - profile.tieDoubleGap;
}

/**
 * Which side of its own centreline a pixel sits on, relative to the key light.
 *
 * Returns +1 on the lit (up/left) side and -1 on the shadowed (down/right) side.
 * The light is fixed in SCREEN space, which is the whole point: `off`'s sign is
 * defined relative to each curve's own travel direction, so a vertical and a
 * horizontal pipe shaded from `off` end up lit from opposite sides and the run
 * reads as a flat painted stripe rather than a tube.
 *
 * The dominant axis — rather than a dot product with a 45-degree vector — is
 * what keeps the JOIN CONTRACT intact. On a boundary row an arc's normal is
 * nearly, but not exactly, axis-aligned (the pixel centre sits half a pixel
 * inside the cell), so a continuous projection would give a corner frame a
 * fractionally different value from the straight it must butt against, and the
 * two could land in different shading bands. Taking the dominant axis collapses
 * that difference to zero on every boundary row.
 */
function litFraction(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return Math.abs(dx) >= Math.abs(dy) ? -Math.sign(dx) : -Math.sign(dy);
}

/**
 * Rasterise one mask into a 64x64 classification grid plus a cross-section
 * coordinate per pixel.
 *
 * `shade[i]` is where the pixel sits ACROSS the member it belongs to, in [-1, 1]
 * (0 at the member's centreline, ±1 at its outer edge). Geometry has to hand
 * this out because the importer cannot recover it: from the class grid alone a
 * pipe is an 18px slab of texture, which is exactly why it read as flat rather
 * than round. With the cross-coordinate the importer can run a proper cylinder
 * ramp — bright along the crown, falling away to both silhouette edges — and a
 * pipe reads as a tube instead of a painted stripe.
 *
 * Pure and total: same mask in, same bytes out, no randomness, no clock.
 */
export interface LineworkFrameRaster {
  readonly cls: Uint8Array;
  readonly shade: Float32Array;
}

export function rasterizeLineworkFrame(
  mask: number,
  profile: LineworkProfile,
  isEndCap: boolean,
): LineworkFrameRaster {
  const size = LINEWORK_CELL_PX;
  const cls = new Uint8Array(size * size);
  const shade = new Float32Array(size * size);
  const curves = curvesForMask(mask);
  if (curves.length === 0) return { cls, shade };
  // Terminal hardware is projected on its OWN extended curve so it can reach
  // past the cell centre; see `CAP_REACH`.
  const terminal = isEndCap ? capCurve(mask) : null;
  const buttressNear = HALF + profile.capHalfWidth;
  const buttressInner = profile.capHalfLength - BUTTRESS_DEPTH;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Pixel centres, so the profile is symmetric about the cell centreline.
      const px = x + 0.5;
      const py = y + 0.5;
      let value: LineworkPixel = LINEWORK_PIXEL.Empty;
      let cross = 0;
      // Cap wins over rail: a buffer stop's beam sits ACROSS the rails, so the
      // rails must read as running into it rather than over it.
      if (terminal) {
        const p = project(terminal, px, py);
        if (p) {
          const absOff = Math.abs(p.off);
          if (absOff <= profile.capHalfLength && Math.abs(p.along - HALF) <= profile.capHalfWidth) {
            value = LINEWORK_PIXEL.Cap;
            cross = (p.along - HALF) / profile.capHalfWidth;
          } else if (
            absOff <= profile.capHalfLength &&
            absOff >= buttressInner &&
            p.along >= buttressNear &&
            p.along <= buttressNear + BUTTRESS_LENGTH
          ) {
            // Two buttress blocks braced behind the beam. They are what makes a
            // terminus read as deliberate hardware instead of a truncated run.
            value = LINEWORK_PIXEL.Cap;
            const mid = (profile.capHalfLength + buttressInner) / 2;
            cross = litFraction(p.dx, p.dy) * ((absOff - mid) / (BUTTRESS_DEPTH / 2));
          }
        }
      }
      for (const curve of value === LINEWORK_PIXEL.Empty ? curves : EMPTY_CURVES) {
        const p = project(curve, px, py);
        if (!p) continue;
        const len = curveLength(curve);
        const onCrossMember =
          Math.abs(p.off) <= profile.tieHalfLength &&
          p.along >= TIE_EDGE_CLEARANCE &&
          p.along <= len - TIE_EDGE_CLEARANCE &&
          Math.abs(ringOffset(p.along, profile)) <= profile.tieHalfWidth;
        if (isRail(p.off, profile)) {
          // A single-bore member (a pipe) is a cylinder, so it must be lit from
          // ONE fixed screen direction regardless of which way the run travels.
          // `litFraction` supplies that side; the normalised bore offset supplies
          // the depth, so +1 is the lit silhouette edge and -1 the shadowed one.
          const round = profile.railOffset === 0;
          // A rivet band WRAPS a pipe, so on a round body the collar takes the
          // pixel and keeps the cylinder cross-coordinate — that is what makes it
          // read as a raised ring instead of two dots stuck to the silhouette.
          // Track sleepers pass UNDER their rails, so rails keep winning there.
          value = round && onCrossMember ? LINEWORK_PIXEL.Tie : LINEWORK_PIXEL.Rail;
          cross = round
            ? litFraction(p.dx, p.dy) * (Math.abs(p.off) / profile.railHalfWidth)
            : // Distance out from this member's own centreline, normalised.
              (Math.abs(p.off) - profile.railOffset) / profile.railHalfWidth;
          break;
        }
        if (onCrossMember) {
          value = LINEWORK_PIXEL.Tie;
          if (profile.railOffset === 0) {
            // The ring's protruding shoulders belong to the same cylinder as the
            // bore they wrap, so they must be lit from the same screen direction.
            cross = litFraction(p.dx, p.dy) * (Math.abs(p.off) / profile.tieHalfLength);
          } else {
            // A cross-member is also a round bar, just oriented along the run.
            const phase = ringPhase(p.along, profile);
            const signed = phase <= profile.tiePeriod - phase ? 1 : -1;
            cross = (signed * ringOffset(p.along, profile)) / profile.tieHalfWidth;
          }
          continue;
        }
      }
      cls[y * size + x] = value;
      shade[y * size + x] = cross < -1 ? -1 : cross > 1 ? 1 : cross;
    }
  }
  return { cls, shade };
}

/** Every mask with exactly one connection is a terminus. */
export function isEndCapMask(mask: number): boolean {
  return mask !== 0 && (mask & (mask - 1)) === 0;
}
