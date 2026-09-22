/**
 * Deterministic, explainable equipment comparison used by balancing surfaces.
 * It deliberately consumes real equipment definitions and weapon definitions;
 * callers never provide a hand-authored "power" value.
 */
import type { EquipmentItemDef } from './equipment-types.js';
import { getWeaponDef } from './weaponDefs.js';
import type { GeneratedEquipmentInstanceV1 } from './generated-equipment-types.js';
import { getGearScoreTargetRange } from './gear-score-policy.js';
import { scoreWeaponDefinition } from './weapon-gear-score.js';
import {
  scoreAbilityGrants,
  scoreEquipmentStatusEffects,
  scoreGearStats,
} from './gear-score-stats.js';

export * from './gear-score-policy.js';
export * from './weapon-gear-score.js';
export * from './gear-score-stats.js';

export type GearRecommendation = 'upgrade' | 'sidegrade' | 'downgrade';
export type GearScoreItem = EquipmentItemDef | GeneratedEquipmentInstanceV1;

export interface GearScoreExplanation {
  readonly recommendation: GearRecommendation;
  readonly score: number;
  readonly currentScore: number;
  readonly delta: number;
  readonly reasons: readonly string[];
}

export function scoreEquipmentDefinition(item: EquipmentItemDef): number {
  let score =
    scoreGearStats(item.statBonuses) + scoreEquipmentStatusEffects(item.grantsStatusEffects);
  if (item.weaponId) {
    const weapon = getWeaponDef(item.weaponId);
    if (weapon) score += scoreWeaponDefinition(weapon).total;
  }
  return score;
}

/** Score frozen generated data without requiring a world or mutable registry. */
export function scoreGeneratedGear(instance: GeneratedEquipmentInstanceV1): number {
  let score =
    scoreGearStats(instance.frozen.statBonuses) +
    scoreAbilityGrants(instance.frozen.abilityGrants, instance.frozen.passiveGrants);
  const weapon = instance.frozen.activeWeaponSnapshot;
  if (weapon) score += scoreWeaponDefinition(weapon).total;
  return score;
}

function isGeneratedGear(item: GearScoreItem): item is GeneratedEquipmentInstanceV1 {
  return 'frozen' in item && 'instanceId' in item;
}

function scoreGearItem(item: GearScoreItem): number {
  return isGeneratedGear(item) ? scoreGeneratedGear(item) : scoreEquipmentDefinition(item);
}

function gearSlots(item: GearScoreItem): readonly string[] {
  return isGeneratedGear(item) ? item.frozen.slots : item.slots;
}

export interface GeneratedGearScoreValidation {
  readonly score: number;
  readonly ceiling: number;
  readonly percentOfCeiling: number;
  readonly withinRarityBand: boolean;
}

/** Canonical floor/rarity/slot validation for one immutable generated item. */
export function validateGeneratedGearScore(
  instance: GeneratedEquipmentInstanceV1,
  floor: number,
): GeneratedGearScoreValidation {
  const range = getGearScoreTargetRange(floor, instance.rarity, instance.frozen.slots);
  const ceiling = range.floorCeiling;
  const score = scoreGeneratedGear(instance);
  const percentOfCeiling = (score / ceiling) * 100;
  return {
    score,
    ceiling,
    percentOfCeiling,
    withinRarityBand: score >= range.minimum && score <= range.maximum,
  };
}

function describe(item: GearScoreItem): readonly string[] {
  const reasons: string[] = [];
  if (isGeneratedGear(item)) {
    const weapon = item.frozen.activeWeaponSnapshot;
    if (weapon)
      reasons.push(
        `${weapon.name} ${scoreWeaponDefinition(weapon).sustainedDamage.toFixed(1)} DPS`,
      );
    for (const [stat, value] of Object.entries(item.frozen.statBonuses).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (value !== 0) reasons.push(`${value > 0 ? '+' : ''}${value} ${stat}`);
    }
    for (const abilityId of item.frozen.abilityGrants) reasons.push(`Grants ${abilityId}`);
    for (const abilityId of item.frozen.passiveGrants) reasons.push(`Grants ${abilityId}`);
    return reasons;
  }
  if (item.weaponId) {
    const weapon = getWeaponDef(item.weaponId);
    if (weapon)
      reasons.push(
        `${weapon.name} ${scoreWeaponDefinition(weapon).sustainedDamage.toFixed(1)} DPS`,
      );
  }
  for (const [stat, value] of Object.entries(item.statBonuses).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (value !== 0) reasons.push(`${value > 0 ? '+' : ''}${value} ${stat}`);
  }
  for (const effect of item.grantsStatusEffects ?? []) {
    const value =
      effect.op === 'multiply'
        ? `${effect.value}x`
        : `${effect.value > 0 ? '+' : ''}${effect.value}`;
    reasons.push(`${value} ${effect.stat}`);
  }
  return reasons;
}

/** Score a candidate as an equip swap against the current real build. */
export function scoreGearCandidate(
  candidate: GearScoreItem | undefined,
  equipped: readonly GearScoreItem[],
): GearScoreExplanation | null {
  if (!candidate) return null;
  const occupied = new Set(gearSlots(candidate));
  const retained = equipped.filter((item) => !gearSlots(item).some((slot) => occupied.has(slot)));
  const currentScore = equipped.reduce((sum, item) => sum + scoreGearItem(item), 0);
  const score =
    retained.reduce((sum, item) => sum + scoreGearItem(item), 0) + scoreGearItem(candidate);
  const delta = score - currentScore;
  const recommendation: GearRecommendation =
    delta > 1 ? 'upgrade' : delta < -1 ? 'downgrade' : 'sidegrade';
  const reasons = describe(candidate);
  return { recommendation, score, currentScore, delta, reasons };
}
