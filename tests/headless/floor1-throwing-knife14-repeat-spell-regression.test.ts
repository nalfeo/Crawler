import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

const HEADLESS_WALL_TIME_CAP_MS = 100_000;
const TEST_TIMEOUT_MS = 260_000;

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runThrowingKnife14(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 14 }), {
    seed: 14,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: HEADLESS_WALL_TIME_CAP_MS,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
    floorId: 'floor1',
  });
}

describe('Floor 1 release sweep throwing-knife-14 repeat-spell regression', () => {
  it(
    'exits instead of reviving an abandoned repeat spell purchase on deterministic paired reruns',
    async () => {
      const first = await runThrowingKnife14();
      const second = await runThrowingKnife14();

      expect(first.startingWeapon).toBe('throwing-knife');
      expect(first.outcome).toBe('victory');
      expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
      expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
      expect(second.outcome).toBe('victory');
      expect(second.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
      expect(second.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
      expect(deterministicStats(second)).toEqual(deterministicStats(first));
    },
    TEST_TIMEOUT_MS,
  );
});
