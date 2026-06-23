import { describe, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

describe('probe', () => {
  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    'seed %i',
    async (seed) => {
      const BUDGET_MS = 5 * 60 * 1000;
      const MAX_FRAMES = Math.ceil((BUDGET_MS * 1.1) / (1000 / 60));
      const ai = new BehaviorTreeAI({ seed });
      const stats = await runHeadless(ai, { seed, maxFrames: MAX_FRAMES });
      console.log(
        `seed ${seed}: ${stats.outcome} ${Math.round(stats.gameTimeMs / 1000)}s lv${stats.finalLevel} ${stats.combat.totalKills}k dmg${stats.combat.damageDealt}`,
      );
    },
    60_000,
  );
});
