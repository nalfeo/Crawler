import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';

const REPRO_SEED = 25;
const REPRO_WEAPON = 'fireball';
const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;

describe('Floor 1 blocked live-player route start regression', () => {
  let stats: RunStats;

  beforeAll(async () => {
    stats = await runHeadless(new BehaviorTreeAI({ seed: REPRO_SEED }), {
      seed: REPRO_SEED,
      forceWeaponId: REPRO_WEAPON,
      maxFrames: MAX_FRAMES,
      maxWallTimeMs: 10 * 60 * 1000,
      weaponPersonas: true,
    });
  }, 480_000);

  it('finishes seed 25 instead of failing strict route replanning at a wall boundary', () => {
    expect(
      stats.outcome,
      `${REPRO_WEAPON}-${REPRO_SEED}: ${stats.outcome} at ` +
        `${(stats.gameTimeMs / 1000).toFixed(2)}s (${stats.error ?? stats.stallReason ?? 'no detail'})`,
    ).toBe('victory');
  });
});
