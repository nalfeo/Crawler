/**
 * Headless telemetry: A/B axis-2 (decision mode) field emission.
 *
 * Verifies that the headless runner threads the AI's decision mode + run-plan
 * slack/urgency into sample events when the provider exposes them:
 *   - Every sample from a BehaviorTreeAI carries `decisionMode` ('legacy').
 *   - Travelling samples (run plan present) carry numeric `slackMs` + `urgency`.
 *   - A scripted provider WITHOUT the getters emits none of the new fields
 *     (present-only spread — no LEGACY-provider regression).
 */

import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { AIDecisionMode, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import { AIState } from '../../src/game/ai/types.js';
import type { SimEvent } from '../../src/game/ai/event-log.js';
import type { GameWorld } from '../../src/core/world.js';
import type { InputState } from '../../src/shared/input.js';

async function captureSamples(ai: AIInputProvider): Promise<SimEvent[]> {
  const events: SimEvent[] = [];
  await runHeadless(ai, {
    seed: 42,
    maxFrames: 600,
    maxWallTimeMs: 30_000,
    forceWeaponId: 'sword',
    eventSampleInterval: 15,
    recordEvent: (event: SimEvent): void => {
      events.push(event);
    },
  });
  return events.filter((e) => e.type === 'sample');
}

describe('headless decision-mode telemetry', () => {
  it('emits decisionMode + slack/urgency on samples for a LEGACY BehaviorTreeAI', async () => {
    const samples = await captureSamples(new BehaviorTreeAI({ seed: 42 }));
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.decisionMode === AIDecisionMode.LEGACY)).toBe(true);

    // At least one travelling sample should carry the numeric run-plan fields.
    const withPlan = samples.filter((s) => s.slackMs !== undefined);
    expect(withPlan.length).toBeGreaterThan(0);
    for (const s of withPlan) {
      expect(typeof s.slackMs).toBe('number');
      expect(typeof s.urgency).toBe('number');
    }
  });

  it('omits the new fields entirely for a provider without the A/B getters', async () => {
    class BareProvider implements AIInputProvider {
      private readonly decision: AIDecision = {
        state: AIState.EXPLORE,
        targetEid: null,
        targetX: null,
        targetY: null,
        reason: 'bare',
        npcInteraction: null,
        debug: null,
      };
      poll(_state: InputState, _world: GameWorld): void {}
      getDecision(): AIDecision {
        return { ...this.decision, debug: null };
      }
      reset(): void {}
    }

    const samples = await captureSamples(new BareProvider());
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.decisionMode).toBeUndefined();
      expect(s.slackMs).toBeUndefined();
      expect(s.urgency).toBeUndefined();
    }
  });
});
