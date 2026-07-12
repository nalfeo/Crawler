import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import { GAME } from '../../src/shared/constants.js';

const FLOOR1_TIME_BUDGET_MS = 6 * 60 * 1000;
const MAX_FRAMES = Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS);
// Keep this below Vitest headless project timeout (180s) so runHeadless's own
// timeout path emits the diagnostic instead of a suite-level timeout abort.
const MAX_WALL_TIME_MS = 170_000;
const CASES = [
  { seed: 8, weapon: 'baseball-bat' },
  { seed: 8, weapon: 'bow' },
  { seed: 8, weapon: 'pistol' },
  { seed: 94, weapon: 'throwing-knife' },
] as const;

type BossSnapshot = {
  slimeRatDefeated: boolean;
  staircaseStarted: boolean;
  staircaseDefeated: boolean;
  staircaseUnlocked: boolean;
};

async function runFloor1Case(
  seed: number,
  weapon: string,
): Promise<{
  stats: RunStats;
  bosses: BossSnapshot;
}> {
  const bosses: BossSnapshot = {
    slimeRatDefeated: false,
    staircaseStarted: false,
    staircaseDefeated: false,
    staircaseUnlocked: false,
  };
  const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: MAX_WALL_TIME_MS,
    forceWeaponId: weapon,
    onFinish: (world) => {
      const objective = world.floorScenario?.objective;
      bosses.slimeRatDefeated = objective?.bossBattles.get('slime-rat')?.defeated === true;
      bosses.staircaseStarted = objective?.bossBattles.get('staircase')?.started === true;
      bosses.staircaseDefeated = objective?.bossBattles.get('staircase')?.defeated === true;
      bosses.staircaseUnlocked = objective?.staircaseUnlocked === true;
    },
  });
  return { stats, bosses };
}

describe('Floor 1 staircase boss-entry survival regressions', () => {
  for (const { seed, weapon } of CASES) {
    it(`seed ${seed} + ${weapon} is an official Floor 1 win`, async () => {
      const run = await runFloor1Case(seed, weapon);
      expect(run.bosses.slimeRatDefeated).toBe(true);
      expect(run.bosses.staircaseStarted).toBe(true);
      expect(run.bosses.staircaseDefeated).toBe(true);
      expect(run.bosses.staircaseUnlocked).toBe(true);
      expect(run.stats.outcome).toBe('victory');
      expect(isOfficialWin(run.stats, FLOOR1_TIME_BUDGET_MS)).toBe(true);
    });
  }
});
