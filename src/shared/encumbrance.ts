/**
 * Encumbrance — carried-mass bands relative to body weight and Strength.
 *
 * Pure, ECS-free math so it's trivially unit-testable. Total mass is body
 * weight (the ECS `Weight` component — body mass, used for knockback too)
 * plus equipped gear weight (unique multi-slot-deduped `EquipmentItemDef
 * .weightLb` sum — see `core/effective-stats.ts#computeEquippedWeightLb`).
 *
 * Thresholds are body-relative and widen with effective Strength: +5 lb per
 * effective point to EVERY threshold, so a stronger character can carry more
 * before slowing down. With today's all-zero `weightLb` catalog this is
 * intentionally inert (equipped weight is always 0), but the formula is fully
 * wired so future non-zero item weights take effect immediately.
 *
 * Bands (inclusive upper boundaries):
 *   <= unburdenedMaxLb  → unburdened (x1.00 move-speed multiplier)
 *   <= encumberedMaxLb  → encumbered (x0.85)
 *   <= heavyMaxLb       → heavy      (x0.70)
 *   above heavyMaxLb    → overloaded (x0.70)
 */

export type EncumbranceBand = 'unburdened' | 'encumbered' | 'heavy' | 'overloaded';

/** Flat lb offset (before the Strength bonus) for each threshold boundary. */
export const ENCUMBRANCE_THRESHOLD_BASE_LB: Readonly<{
  unburdened: number;
  encumbered: number;
  heavy: number;
}> = {
  unburdened: 40,
  encumbered: 80,
  heavy: 120,
};

/** Extra lb added to EVERY threshold per effective Strength point. */
export const ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT = 5;

/** Move-speed multiplier applied for each band. */
export const ENCUMBRANCE_BAND_MULTIPLIER: Readonly<Record<EncumbranceBand, number>> = {
  unburdened: 1,
  encumbered: 0.85,
  heavy: 0.7,
  overloaded: 0.7,
};

export interface EncumbranceThresholds {
  readonly unburdenedMaxLb: number;
  readonly encumberedMaxLb: number;
  readonly heavyMaxLb: number;
}

/**
 * Compute the three body-relative threshold boundaries for an entity with the
 * given body weight and effective Strength.
 */
export function computeEncumbranceThresholds(
  bodyWeightLb: number,
  effectiveStrength: number,
): EncumbranceThresholds {
  const strBonusLb =
    (Number.isFinite(effectiveStrength) ? Math.max(0, effectiveStrength) : 0) *
    ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT;
  const safeBodyWeightLb = Number.isFinite(bodyWeightLb) ? Math.max(0, bodyWeightLb) : 0;
  return {
    unburdenedMaxLb: safeBodyWeightLb + ENCUMBRANCE_THRESHOLD_BASE_LB.unburdened + strBonusLb,
    encumberedMaxLb: safeBodyWeightLb + ENCUMBRANCE_THRESHOLD_BASE_LB.encumbered + strBonusLb,
    heavyMaxLb: safeBodyWeightLb + ENCUMBRANCE_THRESHOLD_BASE_LB.heavy + strBonusLb,
  };
}

/** Classify total carried mass (body + equipped) into an encumbrance band. */
export function computeEncumbranceBand(
  totalMassLb: number,
  thresholds: EncumbranceThresholds,
): EncumbranceBand {
  if (totalMassLb <= thresholds.unburdenedMaxLb) return 'unburdened';
  if (totalMassLb <= thresholds.encumberedMaxLb) return 'encumbered';
  if (totalMassLb <= thresholds.heavyMaxLb) return 'heavy';
  return 'overloaded';
}

/** Move-speed multiplier for a given band. */
export function computeEncumbranceMultiplier(band: EncumbranceBand): number {
  return ENCUMBRANCE_BAND_MULTIPLIER[band];
}

/** Convenience: total mass → band → multiplier, all in one call. */
export function computeEncumbranceMultiplierForMass(
  totalMassLb: number,
  bodyWeightLb: number,
  effectiveStrength: number,
): number {
  const thresholds = computeEncumbranceThresholds(bodyWeightLb, effectiveStrength);
  return computeEncumbranceMultiplier(computeEncumbranceBand(totalMassLb, thresholds));
}
