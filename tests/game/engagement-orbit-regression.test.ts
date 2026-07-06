import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { summarizeEvents, type SimEvent } from '../../src/game/ai/event-log.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIPathingMode } from '../../src/game/ai/types.js';

describe('engagement orbit regression', () => {
  it('seed 3 sword finishes the merchant-charm phase without a long engage stall', async () => {
    const events: SimEvent[] = [];
    const stats = await runHeadless(
      new BehaviorTreeAI({
        seed: 3,
        pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      }),
      {
        seed: 3,
        forceWeaponId: 'sword',
        maxFrames: 25_000,
        maxWallTimeMs: 90_000,
        eventSampleInterval: 5,
        recordEvent: (event) => {
          events.push(event);
        },
      },
    );
    const summary = summarizeEvents(events);

    expect(stats.outcome).toBe('victory');
    expect(stats.quests.questLogCompletions['floor1-shopkeeper-errand']).toBeLessThan(220_000);
    expect(summary.longestKillGapMs).toBeLessThan(30_000);
    expect(stats.aiTelemetry.decisionStateMs.ENGAGE ?? 0).toBeLessThan(180_000);
  }, 120_000);
});
