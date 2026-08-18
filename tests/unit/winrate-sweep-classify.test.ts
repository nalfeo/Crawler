import { describe, expect, it } from 'vitest';

import { classifySweepRun } from '../../scripts/agent/perf/winrate-sweep-classify.js';
import { FLOOR1_TIME_BUDGET_MS } from '../../scripts/agent/perf/winrate-sweep-args.js';
import type { RunStats } from '../../src/game/ai/types.js';

/** Minimal RunStats fixture sufficient for classification. */
function makeStats(overrides: {
  outcome: RunStats['outcome'];
  gameTimeMs: number;
  safeRoomMs?: number;
}): RunStats {
  return {
    totalFrames: 0,
    wallTimeMs: 0,
    gameTimeMs: overrides.gameTimeMs,
    safeRoomMs: overrides.safeRoomMs ?? 0,
    finalFloor: 1,
    finalScore: 0,
    outcome: overrides.outcome,
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
  };
}

const FLOOR1_BUDGET_MS = FLOOR1_TIME_BUDGET_MS; // 6 minutes of active game time

describe('classifySweepRun — Floor 1', () => {
  it('fast victory (under budget): outcomeVictory=true, officialWin=true, slowVictory=false', () => {
    const stats = makeStats({ outcome: 'victory', gameTimeMs: 300_000 });
    const result = classifySweepRun(stats, 'floor1');

    expect(result.outcomeVictory).toBe(true);
    expect(result.officialWin).toBe(true);
    expect(result.slowVictory).toBe(false);
  });

  it('over-budget victory: outcomeVictory=true, officialWin=false, slowVictory=true', () => {
    const stats = makeStats({ outcome: 'victory', gameTimeMs: FLOOR1_BUDGET_MS + 1 });
    const result = classifySweepRun(stats, 'floor1');

    expect(result.outcomeVictory).toBe(true);
    expect(result.officialWin).toBe(false);
    expect(result.slowVictory).toBe(true);
  });

  it('over-budget victory increments win count and slow-victory flag but NOT loss count', () => {
    const stats = makeStats({ outcome: 'victory', gameTimeMs: FLOOR1_BUDGET_MS + 1 });
    let wins = 0;
    let losses = 0;
    let slowVictories = 0;

    const { outcomeVictory, slowVictory } = classifySweepRun(stats, 'floor1');

    // Simulate the aggregation logic from winrate-sweep.ts
    if (outcomeVictory) {
      wins++;
    } else {
      losses++;
    }
    if (slowVictory) {
      slowVictories++;
    }

    expect(wins).toBe(1);
    expect(losses).toBe(0);
    expect(slowVictories).toBe(1);
  });

  it('safe-room-credited victory under active-time budget is a fast win', () => {
    // Raw game time = 650 s (> 600 s budget), but 70 s was safe-room dwell.
    // Active time = 650 - 70 = 580 s < 600 s budget → official win.
    const stats = makeStats({ outcome: 'victory', gameTimeMs: 650_000, safeRoomMs: 70_000 });
    const result = classifySweepRun(stats, 'floor1');

    expect(result.outcomeVictory).toBe(true);
    expect(result.officialWin).toBe(true);
    expect(result.slowVictory).toBe(false);
  });

  it('true loss (timeout): outcomeVictory=false, officialWin=false, slowVictory=false', () => {
    const stats = makeStats({ outcome: 'timeout', gameTimeMs: 400_000 });
    const result = classifySweepRun(stats, 'floor1');

    expect(result.outcomeVictory).toBe(false);
    expect(result.officialWin).toBe(false);
    expect(result.slowVictory).toBe(false);
  });

  it('true loss (death): outcomeVictory=false, officialWin=false, slowVictory=false', () => {
    const stats = makeStats({ outcome: 'death', gameTimeMs: 200_000 });
    const result = classifySweepRun(stats, 'floor1');

    expect(result.outcomeVictory).toBe(false);
    expect(result.officialWin).toBe(false);
    expect(result.slowVictory).toBe(false);
  });
});

describe('classifySweepRun — non-Floor-1', () => {
  it('victory on floor2 is always an official win (no active-time budget)', () => {
    const stats = makeStats({ outcome: 'victory', gameTimeMs: 999_999 });
    const result = classifySweepRun(stats, 'floor2');

    expect(result.outcomeVictory).toBe(true);
    expect(result.officialWin).toBe(true);
    expect(result.slowVictory).toBe(false);
  });

  it('non-victory on floor2 is a true loss', () => {
    const stats = makeStats({ outcome: 'death', gameTimeMs: 200_000 });
    const result = classifySweepRun(stats, 'floor2');

    expect(result.outcomeVictory).toBe(false);
    expect(result.officialWin).toBe(false);
    expect(result.slowVictory).toBe(false);
  });
});
