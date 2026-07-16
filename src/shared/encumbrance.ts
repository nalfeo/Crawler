/**
 * Encumbrance system — computes equipped gear load, carry thresholds, and
 * the resulting encumbrance band for an entity's equipped loadout.
 *
 * Design:
 *   - Only EQUIPPED unique item instances contribute to gear load (bag items
 *     are excluded). Multi-slot items (e.g. two-handed weapons that fill both
 *     `mainHand` and `offHand`) count once via instance-id deduplication,
 *     matching the unique-instance logic in `src/core/effective-stats.ts`.
 *   - Carry thresholds are Strength-adjusted: unburdened capacity =
 *     ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB × STR (floors at STR 1).
 *     Higher STR makes you harder to encumber.
 *   - Four bands: unburdened → encumbered → heavy → overloaded, each spaced
 *     one full unburdened capacity apart.
 *   - Movement penalties are defined here as data; wiring them into the
 *     `moveSpeed` effective-stat pipeline is a follow-up task.
 *
 * See issue #1204 and the acceptance criteria for the equipment weight pass.
 */

import type { EquipmentInstanceId, EquipmentState } from './equipment-types.js';
import type { EquipmentSlotId } from './equipment-slots.js';

// ---------------------------------------------------------------------------
// Band type
// ---------------------------------------------------------------------------

/** The four load bands in ascending order of gear weight. */
export type EncumbranceBand = 'unburdened' | 'encumbered' | 'heavy' | 'overloaded';

// ---------------------------------------------------------------------------
// Threshold constants
// ---------------------------------------------------------------------------

/**
 * Base unburdened carry capacity in lb, before Strength adjustment.
 * At STR 1 (default): unburdened threshold = BASE + PER_STR × 1 = 15 lb.
 *
 * Design anchor: a starter one-handed weapon (~3 lb) with no armour is comfortably
 * unburdened; a full iron-plate loadout (~47+ lb) is overloaded at STR 1.
 */
export const ENCUMBRANCE_BASE_LB = 10 as const;

/**
 * Additional carry capacity per point of Strength (lb / STR point).
 * STR 1 → 15 lb, STR 5 → 35 lb, STR 10 → 60 lb.
 */
export const ENCUMBRANCE_PER_STR_LB = 5 as const;

/**
 * Band boundaries are multiples of the unburdened threshold `cap = BASE + PER_STR × STR`:
 *   - unburdened : gear_lb ≤ cap
 *   - encumbered : cap < gear_lb ≤ cap × ENCUMBERED_FACTOR
 *   - heavy      : cap × ENCUMBERED_FACTOR < gear_lb ≤ cap × HEAVY_FACTOR
 *   - overloaded : gear_lb > cap × HEAVY_FACTOR
 */
export const ENCUMBRANCE_ENCUMBERED_FACTOR = 2 as const;
export const ENCUMBRANCE_HEAVY_FACTOR = 3 as const;

// ---------------------------------------------------------------------------
// Movement penalty table
// ---------------------------------------------------------------------------

/**
 * Additive `moveSpeed` penalty per encumbrance band.
 * These are data anchors; runtime wiring to `EffectiveStats.moveSpeed` is a
 * follow-up task. UI code reads these for display purposes.
 */
export const ENCUMBRANCE_MOVE_PENALTIES: Readonly<Record<EncumbranceBand, number>> = {
  unburdened: 0,
  encumbered: -0.05,
  heavy: -0.15,
  overloaded: -0.3,
} as const;

// ---------------------------------------------------------------------------
// Band labels and colours (used by EquipmentUI)
// ---------------------------------------------------------------------------

/** Short uppercase display label for each band. */
export const ENCUMBRANCE_BAND_LABELS: Readonly<Record<EncumbranceBand, string>> = {
  unburdened: 'UNBURDENED',
  encumbered: 'ENCUMBERED',
  heavy: 'HEAVY',
  overloaded: 'OVERLOADED',
} as const;

/** Hex colour for each band (Phaser-compatible number). */
export const ENCUMBRANCE_BAND_COLORS: Readonly<Record<EncumbranceBand, number>> = {
  unburdened: 0x49d06f, // green
  encumbered: 0xf2c14e, // yellow
  heavy: 0xe8964a, // orange
  overloaded: 0xe8695b, // red
} as const;

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Return the unburdened carry threshold in lb for the given Strength value.
 * `strength` is floored at 1 so a STR-0 entity matches the STR-1 default.
 */
export function getCarryThresholdLb(strength: number): number {
  return ENCUMBRANCE_BASE_LB + ENCUMBRANCE_PER_STR_LB * Math.max(1, Math.floor(strength));
}

/**
 * Map equipped gear weight + entity Strength to an `EncumbranceBand`.
 *
 * @param equippedLb - Sum of `weightLb` across unique equipped item instances.
 * @param strength   - Entity's effective Strength stat (floors at 1).
 */
export function getEncumbranceBand(equippedLb: number, strength: number): EncumbranceBand {
  const cap = getCarryThresholdLb(strength);
  if (equippedLb <= cap) return 'unburdened';
  if (equippedLb <= cap * ENCUMBRANCE_ENCUMBERED_FACTOR) return 'encumbered';
  if (equippedLb <= cap * ENCUMBRANCE_HEAVY_FACTOR) return 'heavy';
  return 'overloaded';
}

/**
 * Return the `moveSpeed` additive penalty for the given encumbrance band.
 * A value of `-0.15` means effective moveSpeed is reduced by 0.15.
 */
export function getEncumbranceMovePenalty(band: EncumbranceBand): number {
  return ENCUMBRANCE_MOVE_PENALTIES[band];
}

/**
 * Compute the total equipped gear weight (lb) for an entity's equipment state.
 *
 * Multi-slot items (e.g. two-handed weapons filling `mainHand` + `offHand`)
 * are counted **once** via instance-id deduplication — the same invariant that
 * `uniqueEquippedDefs` in `src/core/effective-stats.ts` enforces for stat
 * aggregation. Bag items are never part of `EquipmentState` and are therefore
 * automatically excluded.
 *
 * Returns `0` when `equipmentState` is undefined (entity has no equipment).
 */
export function computeEquippedWeightLb(equipmentState: EquipmentState | undefined): number {
  if (!equipmentState) return 0;
  const seen = new Set<EquipmentInstanceId>();
  let total = 0;
  for (const slotId of Object.keys(equipmentState.equipped) as EquipmentSlotId[]) {
    const instId = equipmentState.equipped[slotId] ?? null;
    if (instId === null || seen.has(instId)) continue;
    seen.add(instId);
    const inst = equipmentState.instances.get(instId);
    if (!inst) continue;
    total += inst.def.weightLb;
  }
  return total;
}
