import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';

const MAX_WALL_TIME_MS = 300_000;
const RELEASE_SWEEP_LOSSES = [
  { weapon: 'sword', seed: 5 },
  { weapon: 'pistol', seed: 38 },
  { weapon: 'throwing-knife', seed: 1 },
  { weapon: 'throwing-knife', seed: 11 },
] as const;

describe('Floor 1 release sweep loss regressions', () => {
  for (const { weapon, seed } of RELEASE_SWEEP_LOSSES) {
    it(
      `${weapon} seed ${seed} is an official victory`,
      async () => {
        const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
          seed,
          maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          forceWeaponId: weapon,
          floorId: 'floor1',
        });

        expect(stats.startingWeapon).toBe(weapon);
        expect(stats.outcome).toBe('victory');
        expect(isOfficialWin(stats, FLOOR1_ACTIVE_TIME_BUDGET_MS)).toBe(true);
      },
      10 * 60 * 1000,
    );
  }
});
