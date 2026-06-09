import type { Brief, PaletteColors } from './brief-schema.js';
import {
  alphaBinary,
  anchorOpaque,
  decodeSprite,
  dimensionsExact,
  opaqueBboxFits,
  opaqueRatio,
  paletteMembership,
  type RgbaImage,
  type SensorResult,
} from './sensors/common.js';
import {
  ANCHOR_DERIVABLE_SENSOR,
  anchorDerivable,
  isAnchorDerivableOk,
} from './sensors/anchor-derivable.js';
import type { DerivedAnchor } from './sensors/derive-anchor.js';
import { weaponSensors } from './sensors/weapons.js';

/**
 * Pure candidate scorer. Wraps the universal and family-specific sensors
 * (currently only `weapon`) into a single scorecard for one post-processed
 * 16x16 PNG.
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
 * - `derivedAnchor` is the per-variant grip pixel found by the
 *   `anchor-derivable` sensor — `null` when the brief uses the legacy
 *   `anchor-opaque` sensor, or when derivation failed.
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
   * Anchor derived from the silhouette by the `anchor-derivable` sensor.
   * Null when the brief uses the legacy `anchor-opaque` sensor, or when
   * `anchor-derivable` failed (the failure is still recorded in `breakdown`).
   */
  readonly derivedAnchor: DerivedAnchor | null;
}

/**
 * Score one post-processed 16x16 PNG against its brief.
 *
 * The sensor option overrides on the brief (`brief.sensors`) are merged here
 * with sensor defaults. This is the only place those overrides are consumed,
 * so individual sensors stay simple and the merging policy is one read.
 */
export function scoreCandidate(
  processedPng: Buffer,
  brief: Brief,
  palette: PaletteColors,
): Scorecard {
  const image = decodeSprite(processedPng);
  const breakdown: SensorResult[] = [];

  // Universal sensors. opaqueRatio honors the brief override; the anchor
  // sensor is swapped between `anchor-opaque` (static brief pixel) and
  // `anchor-derivable` (derived per variant) based on `brief.sensors.anchor`.
  for (const result of runUniversal(image, brief, palette)) {
    breakdown.push(result);
  }

  // Family-specific sensors.
  if (brief.type === 'weapon') {
    const opts = brief.sensors.weapon ?? {};
    for (const result of weaponSensors(image, {
      diagonalToleranceDeg: opts.diagonalToleranceDeg,
      orientation: opts.orientation,
    })) {
      breakdown.push(result);
    }
  }

  const score = breakdown.filter((r) => r.ok).length;
  const outOf = breakdown.length;

  // Lift the derived anchor out of the breakdown so consumers don't have to
  // know which slot it occupies. Null when anchor-derivable failed or when
  // the brief uses the legacy anchor-opaque sensor.
  let derivedAnchor: DerivedAnchor | null = null;
  for (const result of breakdown) {
    if (isAnchorDerivableOk(result)) {
      derivedAnchor = result.anchor;
      break;
    }
  }

  return {
    score,
    outOf,
    passed: score === outOf,
    breakdown,
    derivedAnchor,
  };
}

/**
 * Run universal sensors with brief overrides applied to the ones that accept
 * options. Returns results in the same canonical order as the legacy
 * `universalSensors()` helper, but with the anchor slot swapped to
 * `anchor-derivable` when the brief opts in via `sensors.anchor.derive`.
 */
function runUniversal(image: RgbaImage, brief: Brief, palette: PaletteColors): SensorResult[] {
  return [
    dimensionsExact(image, brief),
    alphaBinary(image),
    paletteMembership(image, palette),
    opaqueBboxFits(image),
    resolveOpaqueRatio(image, brief),
    resolveAnchorSensor(image, brief),
  ];
}

function resolveOpaqueRatio(image: RgbaImage, brief: Brief): SensorResult {
  const overrides = brief.sensors.opaqueRatio;
  const min = overrides?.min;
  const max = overrides?.max ?? (brief.postprocessing?.trimAndFit ? 0.92 : undefined);
  if (min === undefined && max === undefined) {
    return opaqueRatio(image);
  }
  return opaqueRatio(image, { min, max });
}

function resolveAnchorSensor(image: RgbaImage, brief: Brief): SensorResult {
  const anchorOpts = brief.sensors.anchor;
  if (anchorOpts?.derive) {
    return anchorDerivable(image, {
      bandRows: anchorOpts.bandRows,
      centerToleranceX: anchorOpts.centerToleranceX,
    });
  }
  return anchorOpaque(image, brief);
}

export { ANCHOR_DERIVABLE_SENSOR };
