import { describe, expect, it } from 'vitest';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  analyzeReleaseBalance,
  assertReleaseBalanceSummary,
  canonicalReleaseBalanceCounts,
} from '../../scripts/agent/perf/release-balance.js';

function run(overrides: Partial<RunStats> = {}): RunStats {
  return {
    totalFrames: 1,
    wallTimeMs: 0,
    gameTimeMs: 1,
    safeRoomMs: 0,
    finalFloor: 1,
    finalScore: 0,
    outcome: 'victory',
    levelUps: [],
    combat: {
      totalKills: 0,
      killsByType: {},
      combatTimeMs: 0,
      engagementCount: 0,
      damageDealt: 0,
      damageTaken: 0,
      damageTakenBySource: {},
    },
    health: { minHealthPercent: 1, closeCallCount: 0, lowHealthCount: 0, finalHealthPercent: 1 },
    quests: {
      questsAccepted: 0,
      questsCompleted: 0,
      questsFailed: [],
      mainQuestAcceptedMs: null,
      mainQuestCompletedMs: null,
      firstQuestCompletedMs: null,
      questLogAccepts: {},
      questLogCompletions: {},
    },
    finalLevel: 7,
    totalXp: 0,
    totalGold: 0,
    startingWeapon: 'sword',
    skills: { grants: [], uniqueAbilityCount: 0, milestonesReached: {}, maxCombatSkillLevel: 4 },
    ...overrides,
  };
}

describe('release balance analysis', () => {
  it('uses canonical cohort counts', () => {
    expect(canonicalReleaseBalanceCounts()).toEqual({
      floor1: 300,
      floor2: 150,
      floor6: 150,
      'floor1-chain': 150,
    });
  });

  it('derives completed durations, incomplete counts, and inclusive skill maxima', () => {
    const summary = analyzeReleaseBalance({
      floor1: [
        run({
          floor1BossProgression: {
            encounters: {
              first: {
                bossEid: 1,
                encounterStarted: true,
                encounterStartedFrame: 1,
                encounterStartedMs: 100,
                playerLevelAtStart: 1,
                playerHealthFractionAtStart: 1,
                encounterDefeated: true,
                encounterDefeatedFrame: 2,
                encounterDefeatedMs: 400,
              },
              unfinished: {
                bossEid: 2,
                encounterStarted: true,
                encounterStartedFrame: 1,
                encounterStartedMs: 100,
                playerLevelAtStart: 1,
                playerHealthFractionAtStart: 1,
                encounterDefeated: false,
                encounterDefeatedFrame: null,
                encounterDefeatedMs: null,
              },
            },
          },
        }),
      ],
      floor2: [
        run({
          skills: {
            grants: [],
            uniqueAbilityCount: 0,
            milestonesReached: {},
            maxCombatSkillLevel: 6,
          },
          floor2Progression: {
            exitCompleted: true,
            hunt: {
              huntTimeMs: 0,
              engageTimeMs: 0,
              engageRatio: 0,
              activeCombatTimeMs: 0,
              activeCombatRatio: 0,
              huntFamilyTrashKills: 0,
              huntNeutralTrashKills: 0,
              averageNearbyEnemies: 0,
              peakNearbyEnemies: 0,
            },
            families: {},
          },
        }),
      ],
      floor1Chain: [run({ finalLevel: 10 })],
    });
    expect(summary.meanFloor1CompletionLevel).toBe(7);
    expect(summary.meanFloor3EntryLevel).toBe(10);
    expect(summary.floor1P90CombatSkillLevel).toBe(4);
    expect(summary.floor2P90CombatSkillLevel).toBe(6);
    expect(summary.meanCompletedBossFightMs).toBe(300);
    expect(summary.incompleteBossFightCount).toBe(1);
  });

  it('reports null skill levels when maxCombatSkillLevel is missing', () => {
    const summary = analyzeReleaseBalance({
      floor1: [
        run({
          skills: {
            grants: [],
            uniqueAbilityCount: 0,
            milestonesReached: {},
            // Missing maxCombatSkillLevel
            maxCombatSkillLevel: undefined as unknown as number,
          },
        }),
      ],
      floor2: [run()],
      floor1Chain: [run()],
    });
    // Floor 1 has missing telemetry, so skill level is null
    expect(summary.floor1P90CombatSkillLevel).toBeNull();
    // Floor 2 has complete telemetry, so skill level is calculated
    expect(summary.floor2P90CombatSkillLevel).toBe(4);
  });

  it('requires complete telemetry for floor2 skill levels', () => {
    const summary = analyzeReleaseBalance({
      floor1: [run()],
      floor2: [
        run(),
        run({
          skills: {
            grants: [],
            uniqueAbilityCount: 0,
            milestonesReached: {},
            // Missing maxCombatSkillLevel
            maxCombatSkillLevel: undefined as unknown as number,
          },
        }),
      ],
      floor1Chain: [run()],
    });
    // Floor 2 has incomplete telemetry (one run missing), so skill level is null
    expect(summary.floor2P90CombatSkillLevel).toBeNull();
  });

  it('accepts canonical release-balance summaries with complete observations', () => {
    const summary = {
      revision: 2,
      floor1RunCount: 300,
      floor2RunCount: 150,
      chainedRunCount: 150,
      meanFloor1CompletionLevel: 7,
      meanFloor3EntryLevel: 10,
      floor1P90CombatSkillLevel: 4,
      floor2P90CombatSkillLevel: 6,
      completedBossFightCount: 100,
      incompleteBossFightCount: 0,
      meanCompletedBossFightMs: 30_000,
    };

    expect(() => assertReleaseBalanceSummary(summary)).not.toThrow();
  });

  it('rejects canonical release-balance summaries with missing telemetry or out-of-range values', () => {
    const summary = {
      revision: 2,
      floor1RunCount: 300,
      floor2RunCount: 150,
      chainedRunCount: 150,
      meanFloor1CompletionLevel: 7,
      meanFloor3EntryLevel: 10,
      floor1P90CombatSkillLevel: null,
      floor2P90CombatSkillLevel: null,
      completedBossFightCount: 100,
      incompleteBossFightCount: 0,
      meanCompletedBossFightMs: null,
    };

    expect(() => assertReleaseBalanceSummary(summary)).toThrow(
      /canonical release-balance gate failed/i,
    );
  });
});
