/**
 * Official headless Floor 1 completion gate.
 *
 * This is the canonical, deterministic regression test that answers the single
 * most important question about the game: **can the AI still clear Floor 1?**
 *
 * It drives the same pure-ECS `runHeadless` pipeline the CLI and the in-browser
 * AI-runner lab use — no Phaser, no DOM, no rendering — so it runs identically
 * locally (`npm run test:headless`) and in CI (the blocking `test-headless`
 * job). A green run proves, end to end, that:
 *
 *   - the behavior-tree AI navigates Floor 1's geometry and progression points,
 *   - every Floor 1 quest can be completed (tutorial, shopkeeper errand, boss
 *     unlock, boss battle),
 *   - the floor is cleared (`outcome === 'victory'`) within the 5-minute design
 *     budget, in deterministic *game* time.
 *
 * ## Why a single fixed seed
 *
 * The simulation is fully deterministic: a given seed produces the exact same
 * run every time, so one pass per seed is authoritative — there is nothing to
 * average over. Seed 10 is the currently re-verified canonical clear (~200s
 * game-time at level 7 with 27 kills, completing all 4 quests under the 300s
 * budget). Because the run exercises the *entire* Floor 1 pipeline —
 * pathfinding, melee/ranged combat, every NPC interaction, the boss fight, and
 * stat progression — a regression in almost any of those systems breaks this
 * seed too, which makes it a strong gate.
 *
 * To add coverage, append known-good seeds to `WINNING_SEEDS` (probe a seed
 * once via `npm run ai:headless -- --seed N` and confirm it reports VICTORY
 * with all four quests before adding it — most seeds do NOT clear within the
 * budget).
 *
 * ## Assertions are on deterministic *game* time, never wall time
 *
 * `gameTimeMs` is simulated time and is identical on every machine; wall-clock
 * time is not (Windows dev box vs. ubuntu CI runner differ by 2–3x). The gate
 * asserts on `gameTimeMs < 5 min` so cross-platform CPU differences can never
 * flake it. `maxFrames` is capped just past the 5-minute deadline so a
 * regression that *fails* to clear ends deterministically and quickly instead
 * of grinding to the 100k-frame default.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
} from '../../src/shared/quest-types.js';

/** Floor 1 design budget: the AI must clear the floor in under five minutes. */
const FLOOR1_TIME_BUDGET_MS = 5 * 60 * 1000;

/**
 * Frame cap for the gate. One frame is `GAME.DELTA_MS` (1000/60 ms) of game
 * time, so this allows the run to advance slightly past the 5-minute deadline
 * (~5.5 min of game time). A legitimate clear finishes well before the budget;
 * a regression that never clears stops here deterministically (bounded wall
 * time) and is then caught by the `outcome`/budget assertions rather than
 * running to the 100k-frame default (~27 min of game time).
 */
const MAX_FRAMES = Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS);

/** Every Floor 1 quest that must be completed for an honest full clear. */
const REQUIRED_QUEST_IDS = [
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
] as const;

/**
 * Deterministic, known-good seeds. Each runs the full Floor 1 clear once and is
 * asserted independently. Keep this list to seeds that have been verified to
 * clear within the budget — see the file header for how to add more.
 */
const WINNING_SEEDS = [10] as const;

/**
 * Run the full headless Floor 1 simulation for a seed. The seed is passed to
 * BOTH the AI (its decision RNG) and `runHeadless` (world generation) so the
 * run is fully reproducible. The default runner seed (12345) does NOT clear
 * Floor 1, so it must never be relied on here.
 */
async function clearFloor1(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, { seed, maxFrames: MAX_FRAMES });
}

describe('Floor 1 headless completion gate', () => {
  for (const seed of WINNING_SEEDS) {
    describe(`seed ${seed}`, () => {
      let stats: RunStats;

      beforeAll(async () => {
        stats = await clearFloor1(seed);
      }, 180_000);

      it('clears the floor (outcome = victory)', () => {
        // Surface the real failure mode (death / timeout / error) in the
        // message so a regression is actionable at a glance.
        expect(
          stats.outcome,
          `expected victory but run ended as "${stats.outcome}"` +
            (stats.error ? ` (${stats.error})` : '') +
            ` at ${(stats.gameTimeMs / 1000).toFixed(1)}s game-time, ` +
            `level ${stats.finalLevel}, ${stats.combat.totalKills} kills`,
        ).toBe('victory');
      });

      it('clears within the 5-minute game-time budget', () => {
        expect(
          stats.gameTimeMs,
          `cleared in ${(stats.gameTimeMs / 1000).toFixed(1)}s — over the ` +
            `${FLOOR1_TIME_BUDGET_MS / 1000}s budget`,
        ).toBeLessThan(FLOOR1_TIME_BUDGET_MS);
      });

      it('completes every Floor 1 quest', () => {
        const completed = stats.quests.questLogCompletions;
        for (const questId of REQUIRED_QUEST_IDS) {
          expect(
            completed[questId],
            `quest "${questId}" was not completed; completed quests: ` +
              `[${Object.keys(completed).join(', ') || 'none'}]`,
          ).toBeTypeOf('number');
        }
      });

      it('makes real combat + progression (sanity)', () => {
        // Guards against a degenerate "victory" reached without actually
        // playing — e.g. a future scenario bug that flags the floor cleared
        // on frame 0. An honest clear levels up and kills enemies.
        expect(stats.finalFloor).toBeGreaterThanOrEqual(1);
        expect(stats.finalLevel).toBeGreaterThanOrEqual(1);
        expect(stats.combat.totalKills).toBeGreaterThan(0);
      });
    });
  }
});
