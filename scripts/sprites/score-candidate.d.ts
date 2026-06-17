import type { Brief, PaletteColors } from './brief-schema.js';
import { type SensorResult } from './sensors/common.js';
import { ANCHOR_DERIVABLE_SENSOR } from './sensors/anchor-derivable.js';
import { ANCHOR_CENTER_OF_MASS_SENSOR } from './sensors/center-of-mass-anchor.js';
import type { DerivedAnchor } from './sensors/derive-anchor.js';
/**
 * Pure candidate scorer. Wraps the universal and family-specific sensors
 * (currently only `weapon`) into a single scorecard for one post-processed
 * native-resolution PNG (typically 64x64).
 *
 * The scorecard is the JSON artifact written next to each variant by the
 * orchestrator. The CLI reads it back to rank candidates and the human picks
 * a winner with `--pick`.
 *
 * Scoring contract (Phase 2, deterministic only):
 * - `score` = number of sensors that returned `ok: true`. Higher is better.
 * - `passed` = every sensor returned `ok: true` (no failures at all).
 * - `breakdown` is the full per-sensor result list, preserved in order, so
 *   reviewers can see exactly which check failed and why.
 * - `derivedAnchor` is the per-variant anchor pixel found by the active
 *   anchor sensor (`anchor-derivable` or `anchor-center-of-mass`) - null
 *   when the brief uses the legacy `anchor-opaque` sensor, or when
 *   derivation failed.
 *
 * There is no subjective "looks good" score in Phase 2. Phase 3's
 * `sprite-forge-lab` will layer that on top of this baseline.
 */
export interface Scorecard {
  /** Number of sensors that returned ok: true. */
  readonly score: number;
  /** Total number of sensors evaluated. */
  readonly outOf: number;
  /** True iff every sensor passed. */
  readonly passed: boolean;
  /** Per-sensor results, in the order the sensors ran. */
  readonly breakdown: ReadonlyArray<SensorResult>;
  /**
   * Anchor derived from the silhouette by the active anchor sensor
   * (`anchor-derivable` or `anchor-center-of-mass`). Null when the brief uses
   * the legacy `anchor-opaque` sensor, or when derivation failed (the failure
   * is still recorded in `breakdown`).
   */
  readonly derivedAnchor: DerivedAnchor | null;
  /**
   * Dual-anchor output for runtime attachment points:
   * - hold: grip/hand attachment candidate
   * - centerOfGravity: physical centroid for motion/rotation pivots
   *
   * These are surfaced regardless of which anchor sensor is used for pass/fail
   * gating, so downstream tooling can consume both points.
   */
  readonly derivedAnchors: {
    readonly hold: DerivedAnchor | null;
    readonly centerOfGravity: DerivedAnchor | null;
  };
}
/**
 * Score one post-processed PNG against its brief.
 *
 * The sensor option overrides on the brief (`brief.sensors`) are merged here
 * with sensor defaults. This is the only place those overrides are consumed,
 * so individual sensors stay simple and the merging policy is one read.
 */
export declare function scoreCandidate(
  processedPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
): Scorecard;
export { ANCHOR_DERIVABLE_SENSOR, ANCHOR_CENTER_OF_MASS_SENSOR };
//# sourceMappingURL=score-candidate.d.ts.map
