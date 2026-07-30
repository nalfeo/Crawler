import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  createEmptyAchievementFactSnapshot,
  mergeAchievementFactSnapshots,
  type AchievementFactSnapshot,
} from '../../src/shared/achievements.js';

const factSnapshotArbitrary: fc.Arbitrary<AchievementFactSnapshot> = fc
  .record({
    totalKills: fc.nat({ max: 10_000 }),
    slimesKilled: fc.nat({ max: 10_000 }),
    ratsKilled: fc.nat({ max: 10_000 }),
    goldCollected: fc.nat({ max: 10_000 }),
    maxSkillLevel: fc.nat({ max: 100 }),
    spentStatPoints: fc.nat({ max: 1_000 }),
    playerGold: fc.nat({ max: 10_000 }),
    peakGold: fc.nat({ max: 10_000 }),
    unlockedAbilityCount: fc.nat({ max: 100 }),
    familiesAtFriendlyCount: fc.nat({ max: 18 }),
    familiesAtHateCount: fc.nat({ max: 18 }),
    familiesAtNeutralOrBetterCount: fc.nat({ max: 18 }),
    familyBossesDefeated: fc.nat({ max: 18 }),
    familyBossEncounterCount: fc.nat({ max: 18 }),
    familiesEngagedInCombatCount: fc.nat({ max: 18 }),
    questIds: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 8 }),
    completedQuestIds: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
      maxLength: 8,
    }),
    reachedFloorIds: fc.uniqueArray(fc.integer({ min: 1, max: 10 }), { maxLength: 5 }),
    clearedFloorIds: fc.uniqueArray(fc.integer({ min: 1, max: 10 }), { maxLength: 5 }),
    booleans: fc.array(fc.boolean(), { minLength: 14, maxLength: 14 }),
  })
  .map((value) => {
    const empty = createEmptyAchievementFactSnapshot();
    return {
      numberFacts: {
        ...empty.numberFacts,
        totalKills: value.totalKills,
        slimesKilled: value.slimesKilled,
        ratsKilled: value.ratsKilled,
        goldCollected: value.goldCollected,
        maxSkillLevel: value.maxSkillLevel,
        spentStatPoints: value.spentStatPoints,
        playerGold: value.playerGold,
        peakGold: value.peakGold,
        unlockedAbilityCount: value.unlockedAbilityCount,
        familiesAtFriendlyCount: value.familiesAtFriendlyCount,
        familiesAtHateCount: value.familiesAtHateCount,
        familiesAtNeutralOrBetterCount: value.familiesAtNeutralOrBetterCount,
        familyBossesDefeated: value.familyBossesDefeated,
        familyBossEncounterCount: value.familyBossEncounterCount,
        familiesEngagedInCombatCount: value.familiesEngagedInCombatCount,
      },
      booleanFacts: {
        staircaseBattleStarted: value.booleans[0]!,
        staircaseSpawned: value.booleans[1]!,
        staircaseUnlocked: value.booleans[2]!,
        safeRoomDiscovered: value.booleans[3]!,
        equipmentUnlocked: value.booleans[4]!,
        staircaseDiscovered: value.booleans[5]!,
        runClearedFloor: value.booleans[6]!,
        hasBetrayedAlly: value.booleans[7]!,
        floor2SafeRoomVisited: value.booleans[8]!,
        hasMetBroker: value.booleans[9]!,
        allPresentFamiliesFriendly: value.booleans[10]!,
        allPresentFamiliesEngagedInCombat: value.booleans[11]!,
        allPresentFamiliesNeutralOrBetter: value.booleans[12]!,
        allPresentFamilyBossesEngaged: value.booleans[13]!,
      },
      questIds: value.questIds,
      completedQuestIds: value.completedQuestIds,
      reachedFloorIds: value.reachedFloorIds,
      clearedFloorIds: value.clearedFloorIds,
    };
  });

describe('achievement fact aggregation invariants', () => {
  it('combines cumulative facts commutatively while taking the current floor wallet balance', () => {
    fc.assert(
      fc.property(factSnapshotArbitrary, factSnapshotArbitrary, (left, right) => {
        const leftThenRight = mergeAchievementFactSnapshots(left, right);
        const rightThenLeft = mergeAchievementFactSnapshots(right, left);

        expect(leftThenRight.numberFacts.playerGold).toBe(right.numberFacts.playerGold);
        expect(rightThenLeft.numberFacts.playerGold).toBe(left.numberFacts.playerGold);
        expect({
          ...leftThenRight,
          numberFacts: { ...leftThenRight.numberFacts, playerGold: 0 },
        }).toEqual({
          ...rightThenLeft,
          numberFacts: { ...rightThenLeft.numberFacts, playerGold: 0 },
        });
      }),
    );
  });

  it('is associative across chained floor transitions', () => {
    fc.assert(
      fc.property(
        factSnapshotArbitrary,
        factSnapshotArbitrary,
        factSnapshotArbitrary,
        (first, second, third) => {
          expect(
            mergeAchievementFactSnapshots(mergeAchievementFactSnapshots(first, second), third),
          ).toEqual(
            mergeAchievementFactSnapshots(first, mergeAchievementFactSnapshots(second, third)),
          );
        },
      ),
    );
  });
});
