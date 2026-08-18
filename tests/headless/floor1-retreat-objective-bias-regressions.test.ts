import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { AIDecisionMode, AIPathingMode, type RunStats } from '../../src/game/ai/types.js';

const MAX_WALL_TIME_MS = 170_000;

// Floor-1 losses recorded by release sweeps. Three distinct root causes in the
// retreat path:
//   * seed 32 — an unbounded objective bias let a remote NPC route outweigh
//     materially safer retreat lanes.
//   * seeds 35/44 — retreat fled purely toward open space, so the escape lane ran
//     backwards off the route and the next progression poll re-walked the same
//     ground into the same pursuers (objective-biased flee scoring fixes it).
//   * seed 34 — the fixed remaining-HP retreat threshold never reacted to damage
//     RATE, so a pinned melee runner bled 121 -> 21 HP in 5.3s before retreat
//     could trigger (the time-to-death bleed-out trigger fixes it).
const CASES = [
  { weapon: 'bow', seed: 32, paired: true },
  { weapon: 'bow', seed: 35, paired: false },
  { weapon: 'baseball-bat', seed: 34, paired: false },
  { weapon: 'throwing-knife', seed: 44, paired: false },
] as const;

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

describe('Floor 1 retreat-routing / bleed-out death regressions', () => {
  for (const { weapon, seed, paired = false } of CASES) {
    it(
      `${weapon} seed ${seed} is an official victory`,
      async () => {
        const run = () =>
          runHeadless(
            new BehaviorTreeAI({
              seed,
              pathingMode: AIPathingMode.RISK_REWARD_FUSED,
              decisionMode: AIDecisionMode.LEGACY,
            }),
            {
              seed,
              maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
              maxWallTimeMs: MAX_WALL_TIME_MS,
              forceWeaponId: weapon,
            },
          );
        const stats = await run();

        expect(stats.startingWeapon).toBe(weapon);
        expect(stats.outcome).toBe('victory');
        expect(isOfficialWin(stats, FLOOR1_ACTIVE_TIME_BUDGET_MS)).toBe(true);

        if (paired) {
          const again = await run();
          expect(deterministicStats(again)).toEqual(deterministicStats(stats));
        }
      },
      10 * 60 * 1000,
    );
  }
});
