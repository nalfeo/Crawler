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
import { deriveAnchor } from './derive-anchor.js';
export const ANCHOR_DERIVABLE_SENSOR = 'anchor-derivable';
export function anchorDerivable(image, options = {}) {
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
export function isAnchorDerivableOk(result) {
  if (!result.ok || result.sensor !== ANCHOR_DERIVABLE_SENSOR) return false;
  const candidate = result;
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  const a = candidate.anchor;
  return typeof a.x === 'number' && typeof a.y === 'number';
}
//# sourceMappingURL=anchor-derivable.js.map
