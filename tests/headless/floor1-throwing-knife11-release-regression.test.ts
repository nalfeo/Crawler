import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runThrowingKnife11(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 11 }), {
    seed: 11,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 90_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
    eventSampleInterval: 60,
    floorId: 'floor1',
  });
}

describe('Floor 1 release sweep throwing-knife-11 regression', () => {
  it('clears within the release floor frame budget on deterministic paired reruns', async () => {
    const first = await runThrowingKnife11();
    const second = await runThrowingKnife11();

    expect(first.startingWeapon).toBe('throwing-knife');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 200_000);
});
