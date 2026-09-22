import { describe, expect, it } from 'vitest';
import {
  GEAR_SCORE_BANDS,
  getFloorGearScoreMultiplier,
  getGearScoreCeiling,
  getGearScoreTargetRange,
  isGearScoreWithinRarityBand,
  scoreEquipmentDefinition,
} from '../../src/shared/gear-score.js';
import { getEquipmentDefForItem, getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import { scoreWeaponDefinition } from '../../src/shared/weapon-gear-score.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  ACTIVE_ABILITY_GRANT_SCORE,
  PASSIVE_ABILITY_GRANT_SCORE,
  scoreAbilityGrants,
  scoreEquipmentStatusEffects,
} from '../../src/shared/gear-score-stats.js';

describe('generic gear score policy', () => {
  it('preserves the approved rarity caps and overlap contract', () => {
    expect(GEAR_SCORE_BANDS).toEqual({
      common: { minimumPercentOfCeiling: 50, maximumPercentOfCeiling: 70 },
      uncommon: { minimumPercentOfCeiling: 65, maximumPercentOfCeiling: 80 },
      rare: { minimumPercentOfCeiling: 75, maximumPercentOfCeiling: 90 },
      epic: { minimumPercentOfCeiling: 85, maximumPercentOfCeiling: 95 },
      legendary: { minimumPercentOfCeiling: 94, maximumPercentOfCeiling: 100 },
    });
    expect(isGearScoreWithinRarityBand('epic', 94)).toBe(true);
    expect(isGearScoreWithinRarityBand('legendary', 94)).toBe(true);
    expect(isGearScoreWithinRarityBand('rare', 91)).toBe(false);
  });

  it('raises the maximum every floor without adding post-legendary tiers', () => {
    expect(getFloorGearScoreMultiplier(2)).toBeCloseTo(29 / 24);
    for (let floor = 2; floor <= 6; floor += 1) {
      expect(getGearScoreCeiling(floor, ['mainHand'])).toBeGreaterThan(
        getGearScoreCeiling(floor - 1, ['mainHand']),
      );
    }
  });

  it('centers next-floor Common on prior-floor Uncommon', () => {
    for (let floor = 2; floor <= 6; floor += 1) {
      const common = getGearScoreTargetRange(floor, 'common', ['chest']);
      const uncommon = getGearScoreTargetRange(floor - 1, 'uncommon', ['chest']);
      expect((common.minimum + common.maximum) / 2).toBeCloseTo(
        (uncommon.minimum + uncommon.maximum) / 2,
      );
    }
  });

  it('keeps every authored item inside its floor, rarity, and slot range', () => {
    const failures: string[] = [];
    for (const itemId of getEquippableItemIds()) {
      const item = getEquipmentDefForItem(itemId)!;
      const floor = item.tags?.includes('floor2') ? 2 : 1;
      const score = scoreEquipmentDefinition(item);
      const range = getGearScoreTargetRange(floor, item.rarity, item.slots);
      if (score < range.minimum || score > range.maximum) {
        failures.push(
          `${itemId}: ${score.toFixed(2)} outside ${range.minimum.toFixed(2)}-${range.maximum.toFixed(2)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps same-floor, same-rarity, same-slot peers within five percent', () => {
    const groups = new Map<string, number[]>();
    for (const itemId of getEquippableItemIds()) {
      const item = getEquipmentDefForItem(itemId)!;
      const floor = item.tags?.includes('floor2') ? 2 : 1;
      const key = `${floor}:${item.rarity}:${[...item.slots].sort().join('+')}`;
      const scores = groups.get(key) ?? [];
      scores.push(scoreEquipmentDefinition(item));
      groups.set(key, scores);
    }
    for (const [key, scores] of groups) {
      if (scores.length < 2) continue;
      const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      expect(Math.max(...scores) - Math.min(...scores), key).toBeLessThanOrEqual(mean * 0.05);
    }
  });

  it('keeps weapons the highest-scoring item category on each floor', () => {
    for (const floor of [1, 2]) {
      const items = getEquippableItemIds()
        .map((id) => getEquipmentDefForItem(id)!)
        .filter((item) => (item.tags?.includes('floor2') ? 2 : 1) === floor);
      const weapons = items.filter((item) => item.weaponId).map(scoreEquipmentDefinition);
      const nonWeapons = items.filter((item) => !item.weaponId).map(scoreEquipmentDefinition);
      const weaponMean = weapons.reduce((sum, score) => sum + score, 0) / weapons.length;
      const nonWeaponMean = nonWeapons.reduce((sum, score) => sum + score, 0) / nonWeapons.length;
      expect(weaponMean, `floor ${floor}`).toBeGreaterThan(nonWeaponMean);
    }
  });

  it('scores beams as one hit per target per activation regardless of visual tick cadence', () => {
    const laser = getWeaponDef('laser')!;
    const score = scoreWeaponDefinition(laser).total;
    expect(
      scoreWeaponDefinition({ ...laser, durationMs: laser.durationMs * 4, beamTickMs: 1 }).total,
    ).toBe(score);
  });

  it('prices active and passive grants into the same item budget', () => {
    expect(scoreAbilityGrants(['fireball'], ['veteran-instinct'])).toBe(
      ACTIVE_ABILITY_GRANT_SCORE + PASSIVE_ABILITY_GRANT_SCORE,
    );
  });

  it('prices permanent equipment status effects into the same item budget', () => {
    const charm = getEquipmentDefForItem('merchants-stained-charm')!;
    expect(scoreEquipmentStatusEffects(charm.grantsStatusEffects)).toBeCloseTo(0.75 * 6);

    const range = getGearScoreTargetRange(1, charm.rarity, charm.slots);
    expect(scoreEquipmentDefinition(charm)).toBeCloseTo((range.minimum + range.maximum) / 2);
  });
});
