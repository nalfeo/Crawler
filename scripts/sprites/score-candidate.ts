import type { Brief, PaletteColors } from './brief-schema.js';
import { decodeSprite, universalSensors, type SensorResult } from './sensors/common.js';
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

  // Universal sensors. opaqueRatio honors the brief override; everything
  // else is parameter-free.
  for (const result of runUniversal(image, brief, palette)) {
    breakdown.push(result);
  }

  // Family-specific sensors.
  if (brief.type === 'weapon') {
    const opts = brief.sensors.weapon ?? {};
    for (const result of weaponSensors(image, {
      diagonalToleranceDeg: opts.diagonalToleranceDeg,
    })) {
      breakdown.push(result);
    }
  }

  const score = breakdown.filter((r) => r.ok).length;
  const outOf = breakdown.length;
  return {
    score,
    outOf,
    passed: score === outOf,
    breakdown,
  };
}

/**
 * Run universal sensors with brief overrides applied to the ones that accept
 * options. Returns results in the same canonical order as
 * `universalSensors()` from `./sensors/common.ts`.
 */
function runUniversal(
  image: ReturnType<typeof decodeSprite>,
  brief: Brief,
  palette: PaletteColors,
): SensorResult[] {
  // For Phase 2, the only universal sensor with brief-overridable thresholds
  // is `opaqueRatio`. Rather than dispatch each sensor individually here,
  // we run them through the shared helper and then re-evaluate opaqueRatio
  // with the brief's overrides when the brief actually sets them.
  const baseline = universalSensors(image, brief, palette);
  const overrides = brief.sensors.opaqueRatio;
  if (!overrides || (overrides.min === undefined && overrides.max === undefined)) {
    return baseline;
  }
  // Replace the baseline opaqueRatio result with one using the overrides.
  return baseline.map((result) => {
    if (result.sensor !== 'opaque-ratio') return result;
    return reEvaluateOpaqueRatio(image, overrides);
  });
}

function reEvaluateOpaqueRatio(
  image: ReturnType<typeof decodeSprite>,
  overrides: { min?: number; max?: number },
): SensorResult {
  // Inline the math to avoid leaking opaqueRatio's defaults when only one
  // bound is overridden.
  const sensor = 'opaque-ratio';
  const total = image.width * image.height;
  if (total === 0) return { ok: false, sensor, reason: 'image has zero pixels' };
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] ?? 0;
      if (a !== 0) count++;
    }
  }
  const ratio = count / total;
  const min = overrides.min ?? 0.1;
  const max = overrides.max ?? 0.65;
  if (ratio < min || ratio > max) {
    return { ok: false, sensor, reason: `opaque ratio ${ratio.toFixed(3)} outside [${min}, ${max}]` };
  }
  return { ok: true, sensor };
}
