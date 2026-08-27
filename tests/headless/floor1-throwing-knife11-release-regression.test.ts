import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

const HEADLESS_WALL_TIME_CAP_MS = 100_000;
const TEST_TIMEOUT_MS = 260_000;

/**
 * Ceiling on the simulated time between the staircase boss dying and the run
 * actually leaving the floor.
 *
 * Once the final boss is dead the staircase is unlocked and sits in the same
 * room, so the only legitimate work left is the bounded pre-exit loot sweep
 * (`MAX_STAIR_DESCEND_DEFER_FRAMES`, 1800 frames = 30 s from the first arrival
 * at the marker) plus the walk back to the marker after it. Anything far beyond
 * that means the AI is standing at the exit unable to use it — the issue #3449
 * deadlock, which parked this exact seed/weapon at (925, 500) for 330 s.
 *
 * 90 s = the 30 s sweep window plus a generous allowance for one full
 * off-marker loot excursion. Measured on this branch: 53.4 s. It is ~4x below
 * the observed regression, so it is a deadlock detector, not a pacing gate.
 */
const MAX_POST_BOSS_EXIT_MS = 90_000;

function expectPromptPostBossExit(stats: RunStats, label: string): void {
  const staircaseBoss = stats.floor1BossProgression?.encounters['staircase'];
  expect(staircaseBoss?.encounterDefeated, `[${label}] staircase boss defeated`).toBe(true);
  const defeatedMs = staircaseBoss?.encounterDefeatedMs;
  expect(defeatedMs, `[${label}] staircase boss defeat time recorded`).not.toBeNull();
  const leftFloorMs = stats.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID];
  expect(leftFloorMs, `[${label}] leave-floor quest completed`).toBeDefined();
  const exitLatencyMs = leftFloorMs! - defeatedMs!;
  expect(
    exitLatencyMs,
    `[${label}] took ${(exitLatencyMs / 1000).toFixed(1)}s to leave after the boss died ` +
      `(ceiling ${MAX_POST_BOSS_EXIT_MS / 1000}s) — regression to the post-boss stair-descend deadlock`,
  ).toBeLessThanOrEqual(MAX_POST_BOSS_EXIT_MS);
}

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runThrowingKnife11(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 11 }), {
    seed: 11,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: HEADLESS_WALL_TIME_CAP_MS,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
    eventSampleInterval: 60,
    floorId: 'floor1',
  });
}

describe('Floor 1 release sweep throwing-knife-11 regression', () => {
  it(
    'clears within the release floor frame budget on deterministic paired reruns',
    async () => {
      const first = await runThrowingKnife11();
      const second = await runThrowingKnife11();

      expect(first.startingWeapon).toBe('throwing-knife');
      expect(first.outcome).toBe('victory');
      expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
      expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
      expect(second.outcome).toBe('victory');
      expect(second.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
      expect(second.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
      expectPromptPostBossExit(first, 'seed 11 · throwing-knife (first run)');
      expectPromptPostBossExit(second, 'seed 11 · throwing-knife (rerun)');
      expect(deterministicStats(second)).toEqual(deterministicStats(first));
    },
    TEST_TIMEOUT_MS,
  );
});
