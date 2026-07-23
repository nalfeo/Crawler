import { describe, expect, it } from 'vitest';
import { aggregateScores, scoreRun, type ScoreBreakdown } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';

function makeRunStats(overrides: Partial<RunStats>): RunStats {
  return {
    totalFrames: 0,
    wallTimeMs: 0,
    gameTimeMs: 0,
    safeRoomMs: 0,
    finalFloor: 1,
    finalScore: 0,
    outcome: 'timeout',
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
    health: {
      minHealthPercent: 1,
      closeCallCount: 0,
      lowHealthCount: 0,
      finalHealthPercent: 1,
    },
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
    finalLevel: 1,
    totalXp: 0,
    totalGold: 0,
    startingWeapon: 'sword',
    ...overrides,
  };
}

describe('ai scoring', () => {
  it('gives victories a dominant score advantage for comparable runs', () => {
    const loss = scoreRun(
      makeRunStats({ outcome: 'timeout', totalXp: 500, finalLevel: 5, totalGold: 80 }),
    );
    const win = scoreRun(
      makeRunStats({ outcome: 'victory', totalXp: 500, finalLevel: 5, totalGold: 80 }),
    );
    expect(win.score).toBeGreaterThan(loss.score);
  });

  it('weights XP efficiency above gold for otherwise-equal runs', () => {
    const lowXpHighGold = scoreRun(
      makeRunStats({ outcome: 'timeout', totalXp: 100, finalLevel: 10, totalGold: 500 }),
    );
    const highXpLowGold = scoreRun(
      makeRunStats({ outcome: 'timeout', totalXp: 200, finalLevel: 10, totalGold: 0 }),
    );
    expect(highXpLowGold.score).toBeGreaterThan(lowXpHighGold.score);
  });

  it('applies time bonus only for victories when a time budget is provided', () => {
    const budgetMs = 300_000;
    const fastWin = scoreRun(
      makeRunStats({ outcome: 'victory', gameTimeMs: 150_000, totalXp: 500, finalLevel: 5 }),
      budgetMs,
    );
    const slowWin = scoreRun(
      makeRunStats({ outcome: 'victory', gameTimeMs: 300_000, totalXp: 500, finalLevel: 5 }),
      budgetMs,
    );
    const fastLoss = scoreRun(
      makeRunStats({ outcome: 'timeout', gameTimeMs: 150_000, totalXp: 500, finalLevel: 5 }),
      budgetMs,
    );

    expect(fastWin.timeBonus).toBeGreaterThan(0);
    expect(slowWin.timeBonus).toBe(0);
    expect(fastLoss.timeBonus).toBe(0);
    expect(fastWin.score).toBeGreaterThan(slowWin.score);
  });

  it('aggregates means and victory rate across breakdowns', () => {
    const breakdowns: ScoreBreakdown[] = [
      { score: 100, victory: true, xpEfficiency: 50, totalGold: 5, timeBonus: 10 },
      { score: 60, victory: false, xpEfficiency: 30, totalGold: 15, timeBonus: 0 },
    ];
    expect(aggregateScores(breakdowns)).toEqual({
      meanScore: 80,
      victoryRate: 0.5,
      meanXpEfficiency: 40,
      meanGold: 10,
    });
  });
});
