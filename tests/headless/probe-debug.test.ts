import { describe, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { SimEvent } from '../../src/game/ai/event-log.js';

describe('seed 2 debug', () => {
  it('probes seed 2 behavior', async () => {
    const BUDGET_MS = 5 * 60 * 1000;
    const MAX_FRAMES = Math.ceil((BUDGET_MS * 1.1) / (1000 / 60));
    const events: SimEvent[] = [];
    const ai = new BehaviorTreeAI({ seed: 2 });
    const stats = await runHeadless(ai, {
      seed: 2,
      maxFrames: MAX_FRAMES,
      recordEvent: (e) => {
        if (events.length < 200) events.push(e);
      },
    });
    console.log('outcome:', stats.outcome);
    console.log('kills:', stats.combat.totalKills, 'dmg:', stats.combat.damageDealt);
    console.log('level:', stats.finalLevel, 'xp:', stats.totalXp);
    console.log('quests accepted:', stats.quests.questsAccepted);
    console.log('quests completed:', stats.quests.questsCompleted);
    // Print first 20 events
    events.slice(0, 20).forEach((e) => console.log(JSON.stringify(e)));
  }, 90_000);
});
