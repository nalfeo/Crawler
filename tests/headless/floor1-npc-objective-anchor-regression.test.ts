import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_SHOP_QUEST_ID } from '../../src/shared/quest-types.js';
import type { RunStats } from '../../src/game/ai/types.js';

const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;
const MAX_WALL_TIME_MS = 30 * 60 * 1000;

const CASES = [
  {
    seed: 21,
    weapon: 'sword',
    requiredQuestId: FLOOR1_SHOP_QUEST_ID,
  },
  {
    seed: 30,
    weapon: 'sword',
    requiredQuestId: FLOOR1_BOSS_BATTLE_QUEST_ID,
  },
  {
    seed: 30,
    weapon: 'fireball',
    requiredQuestId: FLOOR1_BOSS_BATTLE_QUEST_ID,
  },
] as const;

async function runCase(seed: number, weapon: string): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    forceWeaponId: weapon,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: MAX_WALL_TIME_MS,
  });
}

describe('Floor 1 NPC objective-anchor regression', () => {
  for (const { seed, weapon, requiredQuestId } of CASES) {
    describe(`seed ${seed} · ${weapon}`, () => {
      let stats: RunStats;

      beforeAll(async () => {
        stats = await runCase(seed, weapon);
      }, 480_000);

      it(`accepts ${requiredQuestId}`, () => {
        expect(
          stats.quests.questLogAccepts[requiredQuestId],
          `quest ${requiredQuestId} was never accepted for seed ${seed} · ${weapon}`,
        ).toBeTypeOf('number');
      });

      it('clears Floor 1 within the official budget', () => {
        expect(
          isOfficialWin(stats, FLOOR1_ACTIVE_TIME_BUDGET_MS),
          `seed ${seed} · ${weapon} did not clear Floor 1 in time: ` +
            `${stats.outcome}@${(stats.gameTimeMs / 1000).toFixed(0)}s (${stats.stallReason ?? 'no stall reason'})`,
        ).toBe(true);
      });
    });
  }
});
