import type { RunStats } from '../../src/game/ai/types.js';

/** Synthetic diagnostic evidence, never a recorded player session. */
export function makeExperienceRun(overrides: Partial<RunStats> = {}): RunStats {
  const run: RunStats = {
    evaluationContext: {
      source: 'headless',
      seed: 42,
      startFloor: 'floor1',
      available: { combat: true, health: true, progression: true, quests: true },
    },
    playerPersona: 'experienced_player',
    runStartXp: 0,
    runStartLevel: 1,
    movementQuality: {
      wiggleMs: 0,
      wigglePct: 0,
      idleMs: 0,
      idlePct: 0,
      stuckMs: 0,
      stuckPct: 0,
      excludedMs: 0,
      excludedPct: 0,
      travelEfficiency: 1,
      totalPathTravel: 10,
      totalNetDisp: 10,
    },
    totalFrames: 20_000,
    wallTimeMs: 3000,
    gameTimeMs: 320_000,
    safeRoomMs: 0,
    finalFloor: 1,
    finalScore: 1500,
    outcome: 'victory',
    levelUps: [
      { level: 2, gameTimeMs: 45_000, frame: 2700 },
      { level: 3, gameTimeMs: 105_000, frame: 6300 },
      { level: 4, gameTimeMs: 180_000, frame: 10_800 },
    ],
    combat: {
      totalKills: 125,
      killsByType: { rat: 80, slime: 45 },
      combatTimeMs: 165_000,
      engagementCount: 6,
      damageDealt: 4200,
      damageTaken: 950,
      damageTakenBySource: {},
    },
    health: {
      minHealthPercent: 0.15,
      closeCallCount: 2,
      lowHealthCount: 4,
      finalHealthPercent: 0.32,
    },
    quests: {
      questsAccepted: 2,
      questsCompleted: 2,
      questsFailed: [],
      mainQuestAcceptedMs: 30_000,
      mainQuestCompletedMs: 270_000,
      firstQuestCompletedMs: 120_000,
      questLogAccepts: { main: 30_000, side: 90_000 },
      questLogCompletions: { main: 270_000, side: 210_000 },
    },
    finalLevel: 7,
    totalXp: 2050,
    totalGold: 190,
    startingWeapon: 'sword',
  };
  return { ...run, ...overrides };
}
