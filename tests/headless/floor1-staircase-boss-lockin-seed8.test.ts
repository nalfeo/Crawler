import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';

const SEED = 8;
const FLOOR1_TIME_BUDGET_MS = 6 * 60 * 1000;
const MAX_FRAMES = Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS);
const MAX_WALL_TIME_MS = 170_000;
const WEAPONS = ['sword', 'baseball-bat'] as const;

type StaircaseSnapshot = {
  started: boolean;
  defeated: boolean;
};

async function runFloor1Seed8(weapon: (typeof WEAPONS)[number]): Promise<{
  outcome: RunStats['outcome'];
  gameTimeMs: number;
  staircase: StaircaseSnapshot;
}> {
  const staircase: StaircaseSnapshot = { started: false, defeated: false };
  const stats = await runHeadless(new BehaviorTreeAI({ seed: SEED }), {
    seed: SEED,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: MAX_WALL_TIME_MS,
    forceWeaponId: weapon,
    onFinish: (world) => {
      const battle = world.floorScenario?.objective?.bossBattles.get('staircase');
      staircase.started = battle?.started === true;
      staircase.defeated = battle?.defeated === true;
    },
  });
  return { outcome: stats.outcome, gameTimeMs: stats.gameTimeMs, staircase };
}

describe('Floor 1 staircase boss lock-in regression (seed 8)', () => {
  for (const weapon of WEAPONS) {
    it(`${weapon} starts staircase lock-in and does not stall/timeout`, async () => {
      const run = await runFloor1Seed8(weapon);
      expect(run.staircase.started).toBe(true);
      expect(run.outcome).not.toBe('stalled');
      expect(run.outcome).not.toBe('timeout');
      expect(run.gameTimeMs).toBeLessThan(FLOOR1_TIME_BUDGET_MS);
      if (run.staircase.defeated) {
        expect(run.outcome).toBe('victory');
      }
    });
  }
});
