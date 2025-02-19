/**
 * Encumbrance math.
 *
 * This module intentionally exposes two deterministic helper lanes:
 * 1) Body+gear mass snapshots used by the ECS/runtime pipeline.
 * 2) Gear-only threshold helpers used by Equipment UI/lab compatibility tests.
 */

import type { EquipmentInstance, EquipmentInstanceId, EquipmentState } from './equipment-types.js';
import type { EquipmentSlotId } from './equipment-slots.js';

export type EncumbranceBand = 'unburdened' | 'encumbered' | 'heavy' | 'overloaded';

/** Flat lb offset (before the Strength bonus) for each body-relative threshold boundary. */
export const ENCUMBRANCE_THRESHOLD_BASE_LB: Readonly<{
  unburdened: number;
  encumbered: number;
  heavy: number;
}> = {
  unburdened: 40,
  encumbered: 80,
  heavy: 120,
};

/** Extra lb added to every body-relative threshold per effective Strength point. */
export const ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT = 5;

/** Move-speed multiplier applied for each band in the runtime pipeline. */
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

/** Compute body-relative threshold boundaries from body mass + effective Strength. */
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

/** Move-speed multiplier for a given runtime band. */
export function computeEncumbranceMultiplier(band: EncumbranceBand): number {
  return ENCUMBRANCE_BAND_MULTIPLIER[band];
}

/** Convenience helper: total mass → band → multiplier. */
export function computeEncumbranceMultiplierForMass(
  totalMassLb: number,
  bodyWeightLb: number,
  effectiveStrength: number,
): number {
  const thresholds = computeEncumbranceThresholds(bodyWeightLb, effectiveStrength);
  return computeEncumbranceMultiplier(computeEncumbranceBand(totalMassLb, thresholds));
}

/**
 * Legacy/compat gear-only threshold anchors.
 *
 * These are still used by shared/UI tests and equipment labs.
 */
export const ENCUMBRANCE_BASE_LB = 10 as const;
export const ENCUMBRANCE_PER_STR_LB = 5 as const;
const ENCUMBRANCE_ENCUMBERED_FACTOR = 2 as const;
export const ENCUMBRANCE_HEAVY_FACTOR = 3 as const;

/** Additive move-speed penalty table for the gear-only helper lane. */
export const ENCUMBRANCE_MOVE_PENALTIES: Readonly<Record<EncumbranceBand, number>> = {
  unburdened: 0,
  encumbered: -0.05,
  heavy: -0.15,
  overloaded: -0.3,
} as const;

export const ENCUMBRANCE_BAND_LABELS: Readonly<Record<EncumbranceBand, string>> = {
  unburdened: 'UNBURDENED',
  encumbered: 'ENCUMBERED',
  heavy: 'HEAVY',
  overloaded: 'OVERLOADED',
} as const;

/** Return the unburdened carry threshold in lb for the given Strength value. */
export function getCarryThresholdLb(strength: number): number {
  return ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * Math.max(1, Math.floor(strength));
}

/** Map equipped gear weight + Strength to an encumbrance band. */
export function getEncumbranceBand(equippedLb: number, strength: number): EncumbranceBand {
  const cap = getCarryThresholdLb(strength);
  if (equippedLb <= cap) return 'unburdened';
  if (equippedLb <= cap * ENCUMBRANCE_ENCUMBERED_FACTOR) return 'encumbered';
  if (equippedLb <= cap * ENCUMBRANCE_HEAVY_FACTOR) return 'heavy';
  return 'overloaded';
}

/** Return the additive move-speed penalty for a gear-only band. */
export function getEncumbranceMovePenalty(band: EncumbranceBand): number {
  return ENCUMBRANCE_MOVE_PENALTIES[band];
}

/** Compute the total equipped gear weight (lb) with multi-slot instance deduplication. */
export function computeEquippedWeightLb(
  equipmentState: EquipmentState | undefined,
  resolveInstance?: (instanceId: EquipmentInstanceId) => EquipmentInstance | undefined,
): number {
  if (!equipmentState) return 0;
  const resolve =
    resolveInstance ??
    ((instanceId: EquipmentInstanceId): EquipmentInstance | undefined => {
      if (typeof instanceId !== 'number') {
        throw new Error(
          'computeEquippedWeightLb requires an explicit resolveInstance for generated instance ids',
        );
      }
      return equipmentState.instances.get(instanceId);
    });
  const seen = new Set<EquipmentInstanceId>();
  let total = 0;
  for (const slotId of Object.keys(equipmentState.equipped) as EquipmentSlotId[]) {
    const instId = equipmentState.equipped[slotId] ?? null;
    if (instId === null || seen.has(instId)) continue;
    seen.add(instId);
    const inst = resolve(instId);
    if (!inst) continue;
    const w = Number.isFinite(inst.def.weightLb) ? Math.max(0, inst.def.weightLb) : 0;
    total += w;
  }
  return total;
}
