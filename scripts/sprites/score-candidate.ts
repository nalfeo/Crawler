import type { Brief, PaletteColors } from './brief-schema.js';
import {
  alphaBinary,
  anchorOpaque,
  decodeSprite,
  dimensionsExact,
  opaqueBboxFits,
  opaqueBboxFitsWithOptions,
  interiorTransparencyHoles,
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
import {
  ANCHOR_CENTER_OF_MASS_SENSOR,
  anchorCenterOfMass,
} from './sensors/center-of-mass-anchor.js';
import type { DerivedAnchor } from './sensors/derive-anchor.js';
import { silhouetteOrientationAxis, weaponSensors } from './sensors/weapons.js';

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
  } else if (brief.type === 'character') {
    const facing = brief.sensors.enemy?.facing ?? 'front';
    const toleranceDeg = brief.sensors.enemy?.toleranceDeg;
    if (facing === 'front') {
      breakdown.push(
        silhouetteOrientationAxis(image, {
          orientation: 'vertical',
          toleranceDeg,
        }),
      );
    }
  }

  const score = breakdown.filter((r) => r.ok).length;
  const outOf = breakdown.length;

  // Lift the derived anchor out of the breakdown so consumers don't have to
  // know which slot it occupies. Null when the active anchor sensor failed or
  // when the brief uses the legacy anchor-opaque sensor.
  let derivedAnchor: DerivedAnchor | null = null;
  for (const result of breakdown) {
    if (isAnchorDerivableOk(result) || isAnchorCenterOfMassOk(result)) {
      derivedAnchor = result.anchor;
      break;
    }
  }
  const derivedHold = deriveHoldAnchor(image, brief);
  const derivedCenterOfGravity = deriveCenterOfGravityAnchor(image);

  return {
    score,
    outOf,
    passed: score === outOf,
    breakdown,
    derivedAnchor: derivedHold ?? derivedAnchor,
    derivedAnchors: {
      hold: derivedHold ?? derivedAnchor,
      centerOfGravity: derivedCenterOfGravity,
    },
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
    resolvePaletteMembership(image, brief, palette),
    resolveOpaqueBboxFits(image, brief),
    resolveOpaqueRatio(image, brief),
    resolveInteriorHoles(image, brief),
    resolveAnchorSensor(image, brief),
  ];
}

function resolvePaletteMembership(
  image: RgbaImage,
  brief: Brief,
  palette: PaletteColors,
): SensorResult {
  if (brief.postprocessing?.paletteMode !== 'strict') {
    return { ok: true, sensor: 'palette-membership' };
  }
  return paletteMembership(image, palette);
}

function resolveOpaqueBboxFits(image: RgbaImage, brief: Brief): SensorResult {
  const edge = brief.sensors.edge;
  if (!edge) return opaqueBboxFits(image);
  return opaqueBboxFitsWithOptions(image, {
    allowMainTouch: edge.allowMainTouch,
    allowDetachedEdgeComponents: edge.allowDetachedEdgeComponents,
    maxDetachedEdgePixels: edge.maxDetachedEdgePixels,
  });
}

function resolveOpaqueRatio(image: RgbaImage, brief: Brief): SensorResult {
  const overrides = brief.sensors.opaqueRatio;
  if (overrides?.disabled) {
    return { ok: true, sensor: 'opaque-ratio' };
  }
  const min = overrides?.min;
  const max = overrides?.max ?? (brief.postprocessing?.trimAndFit ? 0.92 : undefined);
  if (min === undefined && max === undefined) {
    return opaqueRatio(image);
  }
  return opaqueRatio(image, { min, max });
}

function resolveInteriorHoles(image: RgbaImage, brief: Brief): SensorResult {
  return interiorTransparencyHoles(image, {
    maxPixels: brief.sensors.interiorHoles?.maxPixels,
  });
}

function resolveAnchorSensor(image: RgbaImage, brief: Brief): SensorResult {
  const anchorOpts = brief.sensors.anchor;
  if (anchorOpts?.mode === 'center-of-mass') {
    return anchorCenterOfMass(image);
  }
  if (anchorOpts?.derive || anchorOpts?.mode === 'grip') {
    return anchorDerivable(image, {
      bandRows: anchorOpts.bandRows,
      centerToleranceX: anchorOpts.centerToleranceX,
    });
  }
  return anchorOpaque(image, brief);
}

function isAnchorCenterOfMassOk(
  result: SensorResult,
): result is SensorResult & { ok: true; anchor: { x: number; y: number } } {
  if (!result.ok || result.sensor !== ANCHOR_CENTER_OF_MASS_SENSOR) return false;
  const candidate = result as { anchor?: unknown };
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  const a = candidate.anchor as { x?: unknown; y?: unknown };
  return typeof a.x === 'number' && typeof a.y === 'number';
}

function deriveHoldAnchor(image: RgbaImage, brief: Brief): DerivedAnchor | null {
  const anchorOpts = brief.sensors.anchor;
  if (!(anchorOpts?.derive === true || anchorOpts?.mode === 'grip')) {
    return null;
  }
  const result = anchorDerivable(image, {
    bandRows: anchorOpts?.bandRows,
    centerToleranceX: anchorOpts?.centerToleranceX,
  });
  return isAnchorDerivableOk(result) ? result.anchor : null;
}

function deriveCenterOfGravityAnchor(image: RgbaImage): DerivedAnchor | null {
  const result = anchorCenterOfMass(image);
  return isAnchorCenterOfMassOk(result) ? result.anchor : null;
}

export { ANCHOR_DERIVABLE_SENSOR, ANCHOR_CENTER_OF_MASS_SENSOR };
