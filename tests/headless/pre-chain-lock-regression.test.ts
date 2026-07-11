import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { FLOOR1_FIND_WELCOME_QUEST_ID } from '../../src/shared/quest-types.js';
import type { RunStats } from '../../src/game/ai/types.js';

const PRECHAIN_REPRO_CASES = [
  { seed: 21, weapon: 'sword' },
  { seed: 21, weapon: 'baseball-bat' },
  { seed: 69, weapon: 'sword' },
] as const;

const MAX_FRAMES = 7_200;

function suppressedProgressShare(stats: RunStats): number {
  const stateMs = stats.aiTelemetry?.decisionStateMs ?? {};
  const totalMs = Object.values(stateMs).reduce((sum, value) => sum + value, 0);
  if (totalMs <= 0) {
    return 0;
  }
  const suppressedMs = stateMs.suppressedProgressNav ?? 0;
  return suppressedMs / totalMs;
}

describe('Floor 1 pre-chain tutorial-goon lock regression', () => {
  for (const { seed, weapon } of PRECHAIN_REPRO_CASES) {
    describe(`seed ${seed} · ${weapon}`, () => {
      let stats: RunStats;

      beforeAll(async () => {
        const ai = new BehaviorTreeAI({ seed });
        stats = await runHeadless(ai, {
          seed,
          forceWeaponId: weapon,
          maxFrames: MAX_FRAMES,
        });
      }, 480_000);

      it('completes floor1-find-welcome before the bounded run times out', () => {
        expect(
          stats.quests.questLogCompletions[FLOOR1_FIND_WELCOME_QUEST_ID],
          `quest ${FLOOR1_FIND_WELCOME_QUEST_ID} never completed for seed ${seed} · ${weapon}`,
        ).toBeTypeOf('number');
      });

      it('does not spend most of the run in suppressed pre-chain navigation', () => {
        expect(
          suppressedProgressShare(stats),
          `suppressedProgressNav share too high for seed ${seed} · ${weapon}`,
        ).toBeLessThan(0.3);
      });
    });
  }
});
