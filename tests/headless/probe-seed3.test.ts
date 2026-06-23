import { describe, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

describe('seed 3 debug', () => {
  it('probes seed 3 - wall time capped 5s', async () => {
    const ai = new BehaviorTreeAI({ seed: 3 });
    const stats = await runHeadless(ai, {
      seed: 3,
      maxFrames: 100_000,
      maxWallTimeMs: 5_000, // hard 5s wall clock cap
    });
    console.log('outcome:', stats.outcome, 'gameTime:', Math.round(stats.gameTimeMs / 1000) + 's');
    console.log(
      'kills:',
      stats.combat.totalKills,
      'dmg:',
      stats.combat.damageDealt,
      'lv:',
      stats.finalLevel,
    );
    console.log('frames:', stats.totalFrames, 'wallMs:', stats.wallTimeMs);
  }, 15_000);
});
