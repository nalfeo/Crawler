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
const DIAGONAL_TOLERANCE_RAD = 2 * RAD_PER_DEG;

/**
 * Check that the silhouette has at least one diagonal axis of variation: the
 * principal axis (largest eigenvector of the opaque-pixel covariance) must
 * not be within ±2° of horizontal or vertical.
 *
 * Why: weapons that come out as perfectly axis-aligned blobs read as items,
 * not weapons. Forcing diagonal variance catches "pile of pixels" failures
 * that pass every universal sensor.
 */
export function silhouetteDiagonalAxis(image: RgbaImage): SensorResult {
  const sensor = 'silhouette-diagonal-axis';
  const opaque = gatherOpaquePixels(image);
  if (opaque.length === 0) {
    return { ok: false, sensor, reason: 'no opaque pixels' };
  }
  const angle = principalAxisAngleRadians(opaque);
  if (angle === null) {
    return { ok: false, sensor, reason: 'principal axis undefined (degenerate point cloud)' };
  }
  const halfPi = Math.PI / 2;
  const distFromHorizontal = Math.min(
    Math.abs(angle),
    Math.abs(angle - Math.PI),
    Math.abs(angle + Math.PI),
  );
  const distFromVertical = Math.min(Math.abs(angle - halfPi), Math.abs(angle + halfPi));
  if (distFromHorizontal < DIAGONAL_TOLERANCE_RAD) {
    return {
      ok: false,
      sensor,
      reason: `principal axis ${(angle / RAD_PER_DEG).toFixed(2)}° is within ±2° of horizontal`,
    };
  }
  if (distFromVertical < DIAGONAL_TOLERANCE_RAD) {
    return {
      ok: false,
      sensor,
      reason: `principal axis ${(angle / RAD_PER_DEG).toFixed(2)}° is within ±2° of vertical`,
    };
  }
  return { ok: true, sensor };
}

export function weaponSensors(image: RgbaImage): SensorResult[] {
  return [silhouetteDiagonalAxis(image)];
}

export { RAD_PER_DEG };
