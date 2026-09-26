import type { EquipmentSlotId } from './equipment-slots.js';

export type GearScoreRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export interface GearScoreBand {
  readonly minimumPercentOfCeiling: number;
  readonly maximumPercentOfCeiling: number;
}

const GEAR_SCORE_BANDS: Readonly<Record<GearScoreRarity, GearScoreBand>> = {
  common: { minimumPercentOfCeiling: 50, maximumPercentOfCeiling: 70 },
  uncommon: { minimumPercentOfCeiling: 65, maximumPercentOfCeiling: 80 },
  rare: { minimumPercentOfCeiling: 75, maximumPercentOfCeiling: 90 },
  epic: { minimumPercentOfCeiling: 85, maximumPercentOfCeiling: 95 },
  legendary: { minimumPercentOfCeiling: 94, maximumPercentOfCeiling: 100 },
};

/** Test seam for the approved rarity-cap and overlap contract. */
export const _GEAR_SCORE_BANDS_FOR_TEST = GEAR_SCORE_BANDS;

const GEAR_SLOT_BASE_CEILINGS: Readonly<Record<string, number>> = {
  mainHand: 40,
  offHand: 24,
  chest: 28,
  legs: 22,
  gloves: 18,
  head: 16,
  feet: 17,
  neck: 14,
  ring1: 14,
  ring2: 14,
};

function getFloorGearScoreMultiplier(floor: number): number {
  if (!Number.isInteger(floor) || floor < 1) throw new Error(`Invalid gear-score floor: ${floor}`);
  return (29 / 24) ** (floor - 1);
}

/** Test seam for the floor-growth invariant. */
export function _getFloorGearScoreMultiplierForTest(floor: number): number {
  return getFloorGearScoreMultiplier(floor);
}

export interface GearScoreTargetRange {
  readonly floorCeiling: number;
  readonly minimum: number;
  readonly maximum: number;
}

export function getGearScoreTargetRange(
  floor: number,
  rarity: GearScoreRarity,
  slots: readonly EquipmentSlotId[],
): GearScoreTargetRange {
  const base = Math.max(...slots.map((slot) => GEAR_SLOT_BASE_CEILINGS[slot] ?? 0), 0);
  if (base === 0) throw new Error(`Unknown gear-score slot: ${slots.join(',')}`);
  const floorCeiling = base * getFloorGearScoreMultiplier(floor);
  const band = GEAR_SCORE_BANDS[rarity];
  return {
    floorCeiling,
    minimum: (floorCeiling * band.minimumPercentOfCeiling) / 100,
    maximum: (floorCeiling * band.maximumPercentOfCeiling) / 100,
  };
}

export function _getGearScoreCeilingForTest(
  floor: number,
  slots: readonly EquipmentSlotId[],
  rarity: GearScoreRarity = 'legendary',
): number {
  return getGearScoreTargetRange(floor, rarity, slots).maximum;
}

export function isGearScoreWithinRarityBand(
  rarity: GearScoreRarity,
  percentOfCeiling: number,
): boolean {
  const band = GEAR_SCORE_BANDS[rarity];
  return (
    Number.isFinite(percentOfCeiling) &&
    percentOfCeiling >= band.minimumPercentOfCeiling &&
    percentOfCeiling <= band.maximumPercentOfCeiling
  );
}
