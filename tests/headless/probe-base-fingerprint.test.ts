/**
 * Throwaway probe: capture the seed-42 / 1500-frame fingerprint on Linux CI
 * from the pre-Slice-1 base state. Deliberately asserts against a placeholder
 * so CI prints the actual RunStats numbers via the diff.
 *
 * DELETE THIS FILE — probe branch only.
 */
import { describe, it, expect } from 'vitest';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';

describe('probe: base-branch Linux fingerprint', () => {
  it('captures seed=42 frames=1500 RunStats fingerprint', async () => {
    const ai = new BehaviorTreeAI({ seed: 42 });
    const stats = await runHeadless(ai, {
      seed: 42,
      maxFrames: 1500,
      maxWallTimeMs: Number.POSITIVE_INFINITY,
    });

    const fingerprint = {
      totalFrames: stats.totalFrames,
      outcome: stats.outcome,
      totalKills: stats.combat?.totalKills ?? 0,
      damageDealt: stats.combat?.damageDealt ?? 0,
      damageTaken: stats.combat?.damageTaken ?? 0,
      finalScore: stats.finalScore,
    };

    // Deliberately wrong values so CI diff shows the actual Linux fingerprint.
    expect(fingerprint).toEqual({
      totalFrames: -1,
      outcome: 'PLACEHOLDER',
      totalKills: -1,
      damageDealt: -1,
      damageTaken: -1,
      finalScore: -1,
    });
  }, 120_000);
});
