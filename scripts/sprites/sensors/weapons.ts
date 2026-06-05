/**
 * Weapon-specific sensors.
 *
 * Universal sensors live in `./common.ts`; this file adds checks that only
 * apply to the `weapon` sprite type. Each sensor is unit-testable in
 * isolation by constructing a small RgbaImage by hand.
 *
 * NOTE: This module is the sensor *implementation* — kept free of `describe`/
 * `it` blocks so it can be imported by integration tests without registering
 * (and re-running) the unit tests. The corresponding unit tests live in
 * `./weapons.test.ts`.
 */

import {
  gatherOpaquePixels,
  principalAxisAngleRadians,
  type RgbaImage,
  type SensorResult,
} from './common.js';

const RAD_PER_DEG = Math.PI / 180;

/**
 * Allowed orientations for a weapon silhouette's principal axis.
 *
 * - `'any'` accepts whatever orientation the silhouette ended up with —
 *   the sensor returns `ok: true` as long as the silhouette is non-empty
 *   and has a well-defined principal axis (empty / degenerate silhouettes
 *   still fail with a reason, by design). Use when the brief does not
 *   care which way the weapon points; the engine will rotate it.
 * - `'diagonal'` rejects axes within tolerance of horizontal *or* vertical
 *   (the original behaviour). Use for diagonal-only sprites like swords held
 *   at 45° in side-profile.
 * - `'vertical'` requires the axis to be within tolerance of vertical (±90°).
 *   Use for maces, axes, staves that point straight up.
 * - `'horizontal'` requires the axis to be within tolerance of horizontal
 *   (±0° or ±180°). Use for shortbows or polearms shown lying flat.
 */
export type WeaponOrientation = 'any' | 'diagonal' | 'vertical' | 'horizontal';

/**
 * Check that the weapon silhouette's principal axis matches the brief's
 * requested orientation.
 *
 * Why: weapons that come out as the wrong-axis blob read as items, not
 * weapons. The default `'vertical'` matches what we ask the model for in
 * the prompt (single column, head up) so the in-game renderer can rotate
 * around a known axis. Briefs that explicitly want a non-vertical sprite
 * (e.g. a side-profile sword) override to `'diagonal'`.
 */
export function silhouetteOrientationAxis(
  image: RgbaImage,
  opts: { toleranceDeg?: number; orientation?: WeaponOrientation } = {},
): SensorResult {
  const sensor = 'silhouette-orientation-axis';
  const orientation: WeaponOrientation = opts.orientation ?? 'vertical';
  const toleranceDeg = opts.toleranceDeg ?? 2;
  const toleranceRad = toleranceDeg * RAD_PER_DEG;
  const opaque = gatherOpaquePixels(image);
  if (opaque.length === 0) {
    return { ok: false, sensor, reason: 'no opaque pixels' };
  }
  const angle = principalAxisAngleRadians(opaque);
  if (angle === null) {
    return { ok: false, sensor, reason: 'principal axis undefined (degenerate point cloud)' };
  }
  const angleDeg = angle / RAD_PER_DEG;
  const halfPi = Math.PI / 2;
  const distFromHorizontal = Math.min(
    Math.abs(angle),
    Math.abs(angle - Math.PI),
    Math.abs(angle + Math.PI),
  );
  const distFromVertical = Math.min(Math.abs(angle - halfPi), Math.abs(angle + halfPi));

  if (orientation === 'any') {
    return { ok: true, sensor };
  }
  if (orientation === 'diagonal') {
    if (distFromHorizontal < toleranceRad) {
      return {
        ok: false,
        sensor,
        reason: `principal axis ${angleDeg.toFixed(2)}° is within ±${toleranceDeg}° of horizontal`,
      };
    }
    if (distFromVertical < toleranceRad) {
      return {
        ok: false,
        sensor,
        reason: `principal axis ${angleDeg.toFixed(2)}° is within ±${toleranceDeg}° of vertical`,
      };
    }
    return { ok: true, sensor };
  }
  if (orientation === 'vertical') {
    if (distFromVertical > toleranceRad) {
      return {
        ok: false,
        sensor,
        reason: `principal axis ${angleDeg.toFixed(2)}° is more than ±${toleranceDeg}° away from vertical`,
      };
    }
    return { ok: true, sensor };
  }
  // 'horizontal'
  if (distFromHorizontal > toleranceRad) {
    return {
      ok: false,
      sensor,
      reason: `principal axis ${angleDeg.toFixed(2)}° is more than ±${toleranceDeg}° away from horizontal`,
    };
  }
  return { ok: true, sensor };
}

/**
 * @deprecated Use {@link silhouetteOrientationAxis} with
 * `{ orientation: 'diagonal' }` instead. Kept as a thin shim so existing
 * imports do not break in the same change that introduces orientation
 * configurability.
 */
export function silhouetteDiagonalAxis(
  image: RgbaImage,
  opts: { toleranceDeg?: number } = {},
): SensorResult {
  return silhouetteOrientationAxis(image, {
    toleranceDeg: opts.toleranceDeg,
    orientation: 'diagonal',
  });
}

export function weaponSensors(
  image: RgbaImage,
  opts: { diagonalToleranceDeg?: number; orientation?: WeaponOrientation } = {},
): SensorResult[] {
  return [
    silhouetteOrientationAxis(image, {
      toleranceDeg: opts.diagonalToleranceDeg,
      orientation: opts.orientation,
    }),
  ];
}

export { RAD_PER_DEG };
