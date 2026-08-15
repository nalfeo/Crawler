import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';

const MAX_FRAMES = 23_760;
const MAX_GAME_TIME_MS = MAX_FRAMES * GAME.DELTA_MS;
const MAX_WALL_TIME_MS = 170_000;

// The three Floor-1 losses recorded by the release sweep at 187bc7d6 (297/300).
// Two distinct root causes, both in the retreat path:
//   * seeds 35/44 — retreat fled purely toward open space, so the escape lane ran
//     backwards off the route and the next progression poll re-walked the same
//     ground into the same pursuers (objective-biased flee scoring fixes it).
//   * seed 34 — the fixed remaining-HP retreat threshold never reacted to damage
//     RATE, so a pinned melee runner bled 121 -> 21 HP in 5.3s before retreat
//     could trigger (the time-to-death bleed-out trigger fixes it).
const CASES = [
  { weapon: 'bow', seed: 35 },
  { weapon: 'baseball-bat', seed: 34 },
  { weapon: 'throwing-knife', seed: 44 },
] as const;

describe('Floor 1 retreat-routing / bleed-out death regressions', () => {
  for (const { weapon, seed } of CASES) {
    it(
      `${weapon} seed ${seed} is an official victory`,
      async () => {
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
      },
      10 * 60 * 1000,
    );
  }
});
