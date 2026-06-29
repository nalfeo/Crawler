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
 *   - the floor is cleared (`outcome === 'victory'`) within the 6-minute design
 *     budget, in deterministic *game* time.
 *
 * ## Why a weapon × seed matrix
 *
 * The simulation is fully deterministic: a given (seed, weapon) pair produces
 * the exact same run every time, so one pass per combo is authoritative — there
 * is nothing to average over. The gate runs every {@link WINNING_SEEDS} seed
 * with every {@link GATE_WEAPONS} starter weapon (sword, bow, baseball-bat) and
 * asserts each clears independently. This proves Floor 1 is winnable across
 * fundamentally different combat styles — a tight-range full-damage blade, a
 * leading ranged projectile, and a knockback tip-sweet-spot bludgeon — not just
 * the one weapon the AI happened to pick. Because each run exercises the
 * *entire* Floor 1 pipeline — pathfinding, melee/ranged combat, every NPC
 * interaction, the boss fight, and stat progression — a regression in almost
 * any of those systems breaks the matrix.
 *
 * The deterministic floor-progress stall watchdog (which relocates the AI when
 * quest score, then gold, stops advancing) is exercised here implicitly — it is
 * active for every combo and must never false-fire and derail an otherwise
 * winning run. Its pure scoring function is unit-tested directly in
 * tests/game/floor-progress-score.test.ts.
 *
 * To add coverage, append known-good seeds to `WINNING_SEEDS` — but only after
 * verifying the seed clears on *all three* weapons within budget. Probe each
 * combo via the per-weapon CLI `npm run ai:headless -- --seed N --weapon bow`
 * (repeat for sword and baseball-bat) and confirm every weapon reports VICTORY
 * with all required quests. Seed 10 was a verified all-weapon clear on the
 * previous 120×70 map; its status on the current 240×140 map has not been
 * checked. Most seeds do NOT clear on every weapon within the
 * budget. Note bow runs simulate the full frame budget and are markedly slower
 * in wall time than sword/bat.
 *
 * ## Assertions are on deterministic *game* time, never wall time
 *
 * `gameTimeMs` is simulated time and is identical on every machine; wall-clock
 * time is not (Windows dev box vs. ubuntu CI runner differ by 2–3x). The gate
 * asserts on `gameTimeMs < 6 min` so cross-platform CPU differences can never
 * flake it. `maxFrames` is capped just past the 6-minute deadline so a
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
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
} from '../../src/shared/quest-types.js';

/** Floor 1 design budget: the AI must clear the floor in under six minutes (240×140 map). */
const FLOOR1_TIME_BUDGET_MS = 6 * 60 * 1000;
const HEADLESS_WALL_TIME_CAP_MS = 30 * 60 * 1000;

/**
 * Frame cap for the gate. One frame is `GAME.DELTA_MS` (1000/60 ms) of game
 * time, so this allows the run to advance slightly past the 6-minute deadline
 * (~6.6 min of game time). A legitimate clear finishes well before the budget;
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
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
] as const;

/**
 * Deterministic, known-good seeds. Each is run with every {@link GATE_WEAPONS}
 * weapon (see the matrix below) and every combo is asserted independently. Keep
 * this list to seeds verified to clear on *all three* weapons within the budget
 * — see the file header for how to verify and add more.
 *
 * Verified 2026-06-29 against the 240×140 floor map at the welcome-office
 * target of ~5 hops. All four seeds clear on every weapon comfortably under
 * the 360s budget (bow worst-case ~261–280s):
 *
 * - 13: all-weapon clear; bow ~276s.
 * - 23: all-weapon clear; bow ~261s.
 * - 42: all-weapon clear, generous margin.
 * - 99: all-weapon clear, generous margin.
 *
 * Borderline seeds excluded: 2 (bow 363s, over budget), 8 (sword death),
 * 20 (bow death), and 15/30 (flaky near the budget). Re-verify timings on the
 * current map before adding any seed to the matrix.
 */
const WINNING_SEEDS = [13, 23, 42, 99] as const;

/**
 * Starter weapons the gate proves Floor 1 is winnable with. Each is forced as
 * the AI's equipped weapon (world generation is unchanged — only the combat
 * style differs), exercising three distinct damage models: the sword (full
 * damage anywhere in its arc), the bow (leading ranged projectiles), and the
 * baseball-bat (knockback with a tip sweet-spot / 40% shaft falloff).
 */
const GATE_WEAPONS = ['sword', 'bow', 'baseball-bat'] as const;

/**
 * Per-combo wall-clock budget for the `beforeAll` that runs one full clear.
 * Generous because a bow run simulates the entire ~19.8k-frame budget and is
 * several times slower in wall time than a sword/bat clear (and CI runners are
 * 2–3x slower than a dev box). Correctness is asserted on deterministic *game*
 * time, not this wall-clock guard, so a comfortable margin cannot cause flakes.
 */
const HEADLESS_HOOK_TIMEOUT_MS = 180_000;

/**
 * Coarse per-combo wall-clock ceiling — a **performance-regression guard**, not a
 * correctness SLA. Correctness is asserted on deterministic game-time above; this
 * is the one place the gate looks at wall time, and it does so only to catch a
 * specific class of catastrophic slowdown.
 *
 * Background: a pathfinding regression once made `resolveReachableGoalTile` re-run
 * a ring of ~110–169 rot-js A* searches **every poll** (the fallback was never
 * cached), collapsing the headless runner from <10s to ~58s for a single run —
 * see the 2026-06-25 `headless-runner-pathfinding-slowdown` handoff. That class of
 * regression is ~30x and pushes **every** combo here from a few seconds to well
 * over a minute, so a generous ceiling still catches it decisively.
 *
 * Wall time is machine-variant — CI runners are 2–3x slower than a dev box and
 * subject to noisy-neighbour jitter — so this budget is deliberately loose
 * (~4.5x the slowest combo observed on a dev box, ~6.7s) to **never flake**, while
 * still sitting far below the ~58s blowup it guards against. Do **not** tighten it
 * toward the observed runtimes: that trades a real regression signal for CI
 * flakes. If a combo legitimately approaches this ceiling, raise it.
 */
const HEADLESS_WALL_TIME_BUDGET_MS = 30_000;

/**
 * Run the full headless Floor 1 simulation for a (seed, weapon) pair. The seed
 * is passed to BOTH the AI (its decision RNG) and `runHeadless` (world
 * generation) so the run is fully reproducible; `forceWeaponId` swaps only the
 * equipped starter weapon, leaving world generation identical. The default
 * runner seed (12345) does NOT clear Floor 1, so it must never be relied on here.
 */
async function clearFloor1(seed: number, weapon: string): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: HEADLESS_WALL_TIME_CAP_MS,
    forceWeaponId: weapon,
  });
}

describe('Floor 1 headless completion gate', () => {
  for (const weapon of GATE_WEAPONS) {
    for (const seed of WINNING_SEEDS) {
      describe(`seed ${seed} · ${weapon}`, () => {
        let stats: RunStats;

        beforeAll(async () => {
          stats = await clearFloor1(seed, weapon);
        }, HEADLESS_HOOK_TIMEOUT_MS);

        it('clears the floor (outcome = victory)', () => {
          // Surface the real failure mode (death / timeout / error) in the
          // message so a regression is actionable at a glance.
          expect(
            stats.outcome,
            `[seed ${seed} · ${weapon}] expected victory but run ended as ` +
              `"${stats.outcome}"` +
              (stats.error ? ` (${stats.error})` : '') +
              ` at ${(stats.gameTimeMs / 1000).toFixed(1)}s game-time, ` +
              `level ${stats.finalLevel}, ${stats.combat.totalKills} kills`,
          ).toBe('victory');
        });

        it('clears within the 6-minute game-time budget', () => {
          expect(
            stats.gameTimeMs,
            `[seed ${seed} · ${weapon}] cleared in ` +
              `${(stats.gameTimeMs / 1000).toFixed(1)}s — over the ` +
              `${FLOOR1_TIME_BUDGET_MS / 1000}s budget`,
          ).toBeLessThan(FLOOR1_TIME_BUDGET_MS);
        });

        it('stays within the wall-time budget (perf-regression guard)', () => {
          // Coarse guard against a pathfinding-style blowup (see
          // HEADLESS_WALL_TIME_BUDGET_MS) — the only wall-time assertion in this
          // gate. Game-time above proves the run is correct; this proves it is
          // not catastrophically slow.
          expect(
            stats.wallTimeMs,
            `[seed ${seed} · ${weapon}] took ` +
              `${(stats.wallTimeMs / 1000).toFixed(1)}s wall-clock over ` +
              `${stats.totalFrames} frames — over the ` +
              `${HEADLESS_WALL_TIME_BUDGET_MS / 1000}s perf-regression budget. ` +
              `This is a coarse blowup guard, not a precise SLA; if the run is ` +
              `legitimately this slow now, profile the AI before raising the budget`,
          ).toBeLessThan(HEADLESS_WALL_TIME_BUDGET_MS);
        });

        it('completes every Floor 1 quest', () => {
          const completed = stats.quests.questLogCompletions;
          for (const questId of REQUIRED_QUEST_IDS) {
            expect(
              completed[questId],
              `[seed ${seed} · ${weapon}] quest "${questId}" was not ` +
                `completed; completed quests: ` +
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
  }
});
