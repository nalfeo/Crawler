import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';

const MAX_FRAMES = 23_760;
const MAX_GAME_TIME_MS = MAX_FRAMES * GAME.DELTA_MS;
const MAX_WALL_TIME_MS = 170_000;
const CASES = [
  { weapon: 'baseball-bat', seed: 25 },
  { weapon: 'pistol', seed: 30 },
  { weapon: 'sword', seed: 44 },
  { weapon: 'throwing-knife', seed: 2 },
  { weapon: 'throwing-knife', seed: 6 },
  { weapon: 'throwing-knife', seed: 81 },
  { weapon: 'throwing-knife', seed: 84 },
] as const;

describe('Floor 1 legacy weapon-sweep death regressions', () => {
  for (const { weapon, seed } of CASES) {
    it(`${weapon} seed ${seed} is an official victory`, async () => {
      const stats = await runHeadless(
        new BehaviorTreeAI({
          seed,
          pathingMode: AIPathingMode.RISK_REWARD_FUSED,
          decisionMode: AIDecisionMode.LEGACY,
        }),
        {
          seed,
          maxFrames: MAX_FRAMES,
          maxWallTimeMs: MAX_WALL_TIME_MS,
          forceWeaponId: weapon,
        },
      );

      expect(stats.startingWeapon).toBe(weapon);
      expect(stats.outcome).toBe('victory');
      expect(isOfficialWin(stats, MAX_GAME_TIME_MS)).toBe(true);
    });
  }
});
