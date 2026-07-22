/**
 * `anchor-derivable` sensor.
 *
 * Wraps the pure {@link deriveAnchor} algorithm so it can be slotted into the
 * scorecard alongside the other universal/family sensors. Replaces
 * `anchor-opaque` for briefs that opt in via `sensors.anchor.derive: true`.
 *
 * The successful result carries the derived anchor pixel back to the scorer,
 * which surfaces it in the per-variant scorecard JSON and the run summary so
 * downstream tooling (CLI selection, future SpriteDef promotion) can read the
 * anchor without re-running the algorithm.
 */

import { deriveAnchor, type DeriveAnchorOptions, type DerivedAnchor } from './derive-anchor.js';
import type { RgbaImage, SensorResult } from './common.js';

export const ANCHOR_DERIVABLE_SENSOR = 'anchor-derivable';

/**
 * Sensor result *augmented* with the derived anchor on success. Compatible
 * with the base `SensorResult` shape (same `ok`, `sensor`, `reason` keys)
 * so the scorer can include it in `Scorecard.breakdown` unchanged.
 */
export type AnchorDerivableResult =
  (SensorResult & { ok: true; anchor: DerivedAnchor }) | (SensorResult & { ok: false });

export function anchorDerivable(
  image: RgbaImage,
  options: DeriveAnchorOptions = {},
): AnchorDerivableResult {
  const result = deriveAnchor(image, options);
  if (result.anchor) {
    return {
      ok: true,
      sensor: ANCHOR_DERIVABLE_SENSOR,
      anchor: result.anchor,
    };
  }
  return {
    ok: false,
    sensor: ANCHOR_DERIVABLE_SENSOR,
    reason: result.reason ?? 'derive-anchor returned null without a reason',
  };
}

/**
 * Type guard: narrow a `SensorResult` from `Scorecard.breakdown` to an
 * `anchor-derivable` success carrying its anchor. Used by the orchestrator
 * to lift the anchor up into `RunSummaryEntry` without re-deriving.
 */
export function isAnchorDerivableOk(
  result: SensorResult,
): result is SensorResult & { ok: true; anchor: DerivedAnchor } {
  if (!result.ok || result.sensor !== ANCHOR_DERIVABLE_SENSOR) return false;
  const candidate = result as { anchor?: unknown };
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  const a = candidate.anchor as { x?: unknown; y?: unknown };
  return typeof a.x === 'number' && typeof a.y === 'number';
}
