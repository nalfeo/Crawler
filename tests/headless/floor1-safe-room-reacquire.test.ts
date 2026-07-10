import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import type { RunStats } from '../../src/game/ai/types.js';

const SAFE_ROOM_REACQUIRE_CASES = [
  { seed: 1, weapon: 'pistol' },
  { seed: 1, weapon: 'throwing-knife' },
  { seed: 1, weapon: 'fireball' },
] as const;

const MAX_FRAMES = 24_000;

async function runSafeRoomReacquire(seed: number, weapon: string): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    floorId: 'floor1',
    maxFrames: MAX_FRAMES,
  });
}

describe('Floor 1 safe-room tutorial objective reacquisition', () => {
  for (const { seed, weapon } of SAFE_ROOM_REACQUIRE_CASES) {
    describe(`seed ${seed} · ${weapon}`, () => {
      let stats: RunStats;

      beforeAll(async () => {
        stats = await runSafeRoomReacquire(seed, weapon);
      });

      it('does not freeze on floor1-tutorial progression', () => {
        expect(stats.outcome).not.toBe('stalled');
        expect(
          stats.stallReason ?? '',
          `unexpected stall for seed=${seed}, weapon=${weapon}: ${stats.stallReason ?? '(none)'}`,
        ).not.toContain('floor1-tutorial');
      });

      it('completes tutorial progression and gains real XP', () => {
        expect(stats.quests.questLogCompletions[FLOOR1_TUTORIAL_QUEST_ID]).toBeTypeOf('number');
        expect(stats.finalLevel).toBeGreaterThanOrEqual(1);
        expect(stats.totalXp).toBeGreaterThan(0);
      });
    });
  }
});
