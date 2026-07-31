/**
 * Shared "compatible-boundary" edge-signature helpers.
 *
 * Used by BOTH the caeles-fixture build script (to greedily assign template
 * cells to canonical masks by how well their drawn edges already match the
 * mask's expected cardinal connectivity) and the pack validator (to check the
 * assembled atlas after the fact). Keeping the sampling/classification logic
 * in one place guarantees the assignment and the validation always agree on
 * what "solid-like" vs "open-like" means for an edge.
 *
 * Two named sampling configs are exported because the authored (quadrant-kit)
 * pack and the vendored (caeles) pack were empirically tuned independently:
 *  - `AUTHORED_EDGE_SAMPLING` (thin band, corners excluded) is the exact
 *    parameterization that scores 100% against the quadrant-kit compositor's
 *    geometry (see `quadrant-kit.ts`), which deliberately keeps a corner
 *    sub-square filled only in the 'full' state — sampling into the corner
 *    would conflate that with pure cardinal-edge presence.
 *  - `VENDORED_EDGE_SAMPLING` (thicker band, full edge span including
 *    corners) is the parameterization that best discriminates solid/open
 *    edges in the real caeles line-art template (found via a documented
 *    parameter sweep) and is used both to greedily assign template cells to
 *    masks and to score the resulting assignment.
 *
 * See `validate.ts` module doc for the full design rationale.
 */
import { cropImage, type RgbaImage } from './png-buffer.js';
import {
  sampleSignature,
  signatureDistance,
  ZERO_SIGNATURE,
  type SampleSignature,
} from './sample-signature.js';

export type CellEdge = 'N' | 'E' | 'S' | 'W';
export const CELL_EDGES: readonly CellEdge[] = ['N', 'E', 'S', 'W'];

export interface EdgeSamplingConfig {
  /** Band thickness as a fraction of the cell size. */
  readonly bandThicknessFraction: number;
  /** Fraction of the edge length excluded from each end (corner exclusion). 0 = full span. */
  readonly marginFraction: number;
}

/** Tuned for the authored quadrant-kit pack — see module doc. */
export const AUTHORED_EDGE_SAMPLING: EdgeSamplingConfig = {
  bandThicknessFraction: 0.15,
  marginFraction: 0.25,
};
/** Tuned for the vendored caeles line-art template — see module doc. */
export const VENDORED_EDGE_SAMPLING: EdgeSamplingConfig = {
  bandThicknessFraction: 0.35,
  marginFraction: 0,
};

/** Extract a thin sample band along one edge of a (square) cell per the given sampling config. */
function sampleEdgeBand(cell: RgbaImage, edge: CellEdge, config: EdgeSamplingConfig): RgbaImage {
  const size = cell.width;
  const bandThickness = Math.max(2, Math.round(size * config.bandThicknessFraction));
  const marginStart = Math.round(size * config.marginFraction);
  const spanLen = size - marginStart * 2;
  switch (edge) {
    case 'N':
      return cropImage(cell, marginStart, 0, spanLen, bandThickness);
    case 'S':
      return cropImage(cell, marginStart, size - bandThickness, spanLen, bandThickness);
    case 'W':
      return cropImage(cell, 0, marginStart, bandThickness, spanLen);
    case 'E':
      return cropImage(cell, size - bandThickness, marginStart, bandThickness, spanLen);
  }
}

/** Per-edge open/solid reference signatures derived from two reference cells. */
export interface EdgeReferences {
  readonly open: Readonly<Record<CellEdge, SampleSignature>>;
  readonly solid: Readonly<Record<CellEdge, SampleSignature>>;
}

export function buildEdgeReferences(
  openRefCell: RgbaImage,
  solidRefCell: RgbaImage,
  config: EdgeSamplingConfig,
): EdgeReferences {
  const open: Record<CellEdge, SampleSignature> = {
    N: ZERO_SIGNATURE,
    E: ZERO_SIGNATURE,
    S: ZERO_SIGNATURE,
    W: ZERO_SIGNATURE,
  };
  const solid: Record<CellEdge, SampleSignature> = {
    N: ZERO_SIGNATURE,
    E: ZERO_SIGNATURE,
    S: ZERO_SIGNATURE,
    W: ZERO_SIGNATURE,
  };
  for (const edge of CELL_EDGES) {
    open[edge] = sampleSignature(sampleEdgeBand(openRefCell, edge, config));
    solid[edge] = sampleSignature(sampleEdgeBand(solidRefCell, edge, config));
  }
  return { open, solid };
}

/** Classify each edge of `cell` as solid-like (true) or open-like (false) vs the given references. */
export function classifyCellEdges(
  cell: RgbaImage,
  refs: EdgeReferences,
  config: EdgeSamplingConfig,
): Record<CellEdge, boolean> {
  const out: Record<CellEdge, boolean> = { N: false, E: false, S: false, W: false };
  for (const edge of CELL_EDGES) {
    const sig = sampleSignature(sampleEdgeBand(cell, edge, config));
    out[edge] = signatureDistance(sig, refs.solid[edge]) < signatureDistance(sig, refs.open[edge]);
  }
  return out;
}
