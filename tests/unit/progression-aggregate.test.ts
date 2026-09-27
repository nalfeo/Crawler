import { describe, expect, it } from 'vitest';
import { aggregateProgression } from '../../scripts/agent/perf/progression-aggregate.js';
import type { ProgressionRunStats } from '../../src/game/ai/progression-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';

function leg(index: number): RunStats {
  return {
    evaluationContext: {
      source: 'headless',
      seed: 42,
      startFloor: `floor${index + 1}`,
      available: { combat: true, health: true, progression: true, quests: true },
    },
    totalFrames: 100,
    wallTimeMs: 10,
    gameTimeMs: 1000,
    safeRoomMs: 100,
    finalFloor: index + 1,
    finalScore: 5,
    outcome: 'victory',
    combat: {
      totalKills: 3,
      killsByType: { bat: 3 },
      combatTimeMs: 0,
      engagementCount: 0,
      damageDealt: 100,
      damageTaken: 10,
      damageTakenBySource: { bat: 10 },
    },
    health: {
      minHealthPercent: 0.2 + index * 0.1,
      finalHealthPercent: 0.8 - index * 0.1,
      closeCallCount: 1,
      lowHealthCount: 2,
    },
    quests: {
      questsAccepted: 1,
      questsCompleted: 1,
      questsFailed: [],
      mainQuestAcceptedMs: 100,
      mainQuestCompletedMs: 900,
      firstQuestCompletedMs: 900,
      questLogAccepts: { same: 100 },
      questLogCompletions: { same: 900 },
    },
    levelUps: [{ level: 6 + index, gameTimeMs: 500, frame: 50 }],
    runStartXp: 100 + index * 30,
    totalXp: 130 + index * 30,
    runStartLevel: 5 + index,
    finalLevel: 6 + index,
    totalGold: 15,
    startingWeapon: 'sword',
    playerPersona: 'experienced_player',
    rewardEvents: {
      activeDurationMs: 900,
      events: [{ kind: 'level_up', sourceId: 'same', gameTimeMs: 500, activeTimeMs: 400 }],
    },
  };
}
function chain(count: number): ProgressionRunStats {
  const legs = Array.from({ length: count }, (_, i) => ({
    floorId: `floor${i + 1}`,
    stats: leg(i),
  }));
  return {
    legs,
    clearedFloorIds: legs.map((l) => l.floorId),
    winnableFloorIds: legs.map((l) => l.floorId),
    exhibitionFloorIds: [],
    finalFloorId: legs.at(-1)!.floorId,
    reachedFinalVictory: true,
    totalGameTimeMs: count * 1000,
    totalSafeRoomMs: count * 100,
    totalActiveTimeMs: count * 900,
    totalFrames: count * 100,
    totalWallTimeMs: count * 10,
    budgetMs: 5000,
    officialWin: false,
  };
}

describe('whole-run evidence aggregation', () => {
  it.each([2, 3])('conserves %i leg totals without earning carryover twice', (count) => {
    const input = chain(count);
    const before = structuredClone(input);
    const result = aggregateProgression(input);
    expect(result.combat.totalKills).toBe(count * 3);
    expect(result.combat.damageDealt).toBe(count * 100);
    expect(result.combat.damageTakenBySource).toEqual({ bat: count * 10 });
    expect(result.totalXp - result.runStartXp!).toBe(count * 30);
    expect(result.finalLevel - result.runStartLevel!).toBe(count);
    expect(result.health.minHealthPercent).toBe(0.2);
    expect(result.health.finalHealthPercent).toBe(
      input.legs.at(-1)!.stats.health.finalHealthPercent,
    );
    expect(result.health.closeCallCount).toBe(count);
    expect(result.quests.questsCompleted).toBe(count);
    expect(Object.keys(result.quests.questLogCompletions)).toHaveLength(count);
    expect(result.levelUps.at(-1)).toMatchObject({
      gameTimeMs: (count - 1) * 1000 + 500,
      frame: (count - 1) * 100 + 50,
    });
    expect(result.rewardEvents?.events.at(-1)).toMatchObject({
      gameTimeMs: (count - 1) * 1000 + 500,
      activeTimeMs: (count - 1) * 900 + 400,
    });
    expect(result.rewardEvents?.activeDurationMs).toBe(count * 900);
    expect(result.evaluationContext?.available).toEqual({
      combat: true,
      health: true,
      progression: true,
      quests: true,
    });
    expect(result.chainedOfficialWin).toBe(false);
    expect(result.outcome).toBe('victory');
    expect(result.chainedLegs).toEqual(input.legs);
    expect(input).toEqual(before);
  });
  it('keeps single-leg output stable', () => {
    const input = chain(1);
    expect(aggregateProgression(input)).toMatchObject(input.legs[0]!.stats);
  });
  it.each(['error', 'partial', 'missing', 'duration'] as const)(
    'fails closed for %s evidence',
    (fault) => {
      const input = chain(2);
      if (fault === 'error') input.legs[1]!.stats.outcome = 'error';
      if (fault === 'partial') input.legs[0]!.stats.outcome = 'timeout';
      if (fault === 'missing') input.legs[0]!.stats.evaluationContext = undefined;
      if (fault === 'duration') input.totalGameTimeMs += 1;
      const result = aggregateProgression(input);
      expect(Object.values(result.evaluationContext?.available ?? {})).not.toContain(true);
      expect(result.rewardEvents).toBeUndefined();
    },
  );
  it('requires every leg for each independent evidence group', () => {
    const input = chain(2);
    input.legs[0]!.stats.evaluationContext!.available.health = false;
    input.legs[1]!.stats.runStartXp = undefined;
    input.legs[0]!.stats.rewardEvents = undefined;
    const result = aggregateProgression(input);
    expect(result.evaluationContext?.available).toEqual({
      combat: true,
      health: false,
      progression: false,
      quests: true,
    });
    expect(result.rewardEvents).toBeUndefined();
    expect(result.itemInteractions).toBeUndefined();
    expect(result.movementQuality).toBeUndefined();
  });
  it('includes a measured terminal death without turning it into a win', () => {
    const input = chain(2);
    input.legs[1]!.stats.outcome = 'death';
    input.reachedFinalVictory = false;
    const result = aggregateProgression(input);
    expect(result.evaluationContext?.available.combat).toBe(true);
    expect(result.outcome).toBe('death');
  });
  it('rejects empty chains', () => {
    expect(() => aggregateProgression({ ...chain(1), legs: [] })).toThrow('no legs');
  });
  it.each([1, 2])('does not measure a %i-leg victorious prefix missing its tail', (count) => {
    const input = chain(count);
    input.winnableFloorIds.push('floor' + (count + 1));
    input.reachedFinalVictory = false;
    const result = aggregateProgression(input);
    expect(Object.values(result.evaluationContext!.available)).not.toContain(true);
    expect(result.rewardEvents).toBeUndefined();
  });
});
