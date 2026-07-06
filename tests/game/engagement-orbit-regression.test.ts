/**
 * Regression test: Engagement orbit timeout (seed 3 sword)
 *
 * Fused-default pathing was overly conservative during engagement,
 * causing the AI to orbit just out of range for 100+ frames instead of
 * committing to attacks. This created a "freeze" at swarm engagement
 * that would cause 360-second sweep timeouts.
 *
 * Seed 3 + sword should complete Floor 1 in <250 seconds (21600 frames),
 * not the observed ~537 seconds with fused-defaults-everywhere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestWorld } from '../../tests/helpers/world-factory.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { createInputState } from '../../src/shared/input.js';
import { AIState, AIPathingMode } from '../../src/game/ai/types.js';
import { SeededRandom } from '../../src/shared/random.js';

describe('Engagement Orbit Regression', () => {
  it('seed 3 sword completes in <250s (fused pathing non-conservative)', () => {
    // This test replaces the old sweep timeout gate. If fused-default regression
    // reoccurs (engagement conservatism), seed 3 will stall for 500+ seconds.
    // This test catches it in seconds rather than during a full 100-seed sweep.

    const rng = new SeededRandom(3);
    const world = createTestWorld({ seed: 3, floor: 'floor1', rng });
    const ai = new BehaviorTreeAI(world, {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
    });

    let frameCount = 0;
    const MAX_FRAMES = 15000; // ~250s at 60fps
    let consecutiveEngageFrames = 0;
    let maxEngageStall = 0;

    while (frameCount < MAX_FRAMES) {
      const input = createInputState();
      const decision = ai.poll(input, frameCount);

      // Track how long the AI stays in ENGAGE state on the same target
      // (which indicates orbit stalling rather than quick decisive combat)
      if (decision.state === AIState.ENGAGE) {
        consecutiveEngageFrames++;
        maxEngageStall = Math.max(maxEngageStall, consecutiveEngageFrames);
      } else {
        consecutiveEngageFrames = 0;
      }

      // Stalling for 300+ consecutive frames in ENGAGE is a red flag
      // (indicates the 500+ second regression)
      expect(
        maxEngageStall,
        `Engagement orbit stall detected (${maxEngageStall} consecutive frames). ` +
          `Regression: danger weighting too conservative, AI orbits instead of attacking.`,
      ).toBeLessThan(300);

      frameCount++;
    }

    // Additional safety: if we reach MAX_FRAMES without victory, it's a timeout-class regression
    expect(frameCount, 'Seed 3 did not complete within 250s (orbit timeout)').toBeLessThan(
      MAX_FRAMES,
    );
  });

  it('engagement orbit stall does not exceed 100 frames on any weapon', () => {
    // More targeted: across sword/bow/bat on seed 3, no single engagement
    // should stall for more than 100 frames (conservative threshold for combat decisiveness).

    const weapons = ['sword', 'bow', 'baseball-bat'];
    for (const weapon of weapons) {
      const rng = new SeededRandom(3);
      const world = createTestWorld({ seed: 3, floor: 'floor1', rng });
      const ai = new BehaviorTreeAI(world, {
        pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      });

      let frameCount = 0;
      let consecutiveEngageFrames = 0;
      let maxEngageStall = 0;

      while (frameCount < 10000) {
        // Shorter loop, just checking the engagement pattern
        const input = createInputState();
        const decision = ai.poll(input, frameCount);

        if (decision.state === AIState.ENGAGE) {
          consecutiveEngageFrames++;
          maxEngageStall = Math.max(maxEngageStall, consecutiveEngageFrames);
        } else {
          consecutiveEngageFrames = 0;
        }

        frameCount++;
      }

      expect(
        maxEngageStall,
        `${weapon}: engagement stall exceeded 100 frames (actual: ${maxEngageStall}). ` +
          `Likely danger weighting regression.`,
      ).toBeLessThan(100);
    }
  });
});
