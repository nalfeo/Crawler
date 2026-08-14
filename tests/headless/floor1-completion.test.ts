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
 *   - the floor is cleared (`outcome === 'victory'`) within the stricter
 *     6-minute AI budget, in deterministic *game* time. The human-facing
 *     collapse timer is longer and remains configured in the Floor 1 manifest.
 *
 * ## Why a sampled win-RATE, not cherry-picked seeds
 *
 * The simulation is fully deterministic: a given (seed, weapon) pair produces
 * the exact same run every time, so a run is authoritative — there is nothing to
 * average over. The gate runs a **contiguous prefix** of seeds (1..N, see
 * {@link SAMPLE_SEEDS}) with every {@link GATE_WEAPONS} starter weapon and
 * asserts the **win-rate** per weapon clears a {@link MIN_WIN_RATE} floor. A
 * contiguous prefix cannot be gamed by hand-picking comfortable seeds: any
 * failing seed in range drags the rate down exactly as it should (AGENTS.md
 * r13). This proves Floor 1 is winnable across fundamentally different combat
 * styles — a tight-range full-damage blade, a leading ranged projectile, and a
 * knockback tip-sweet-spot bludgeon. Because each run exercises the *entire*
 * Floor 1 pipeline — pathfinding, melee/ranged combat, every NPC interaction,
 * the boss fight, and stat progression — a broad regression sinks the rate.
 *
 * The deterministic floor-progress stall watchdog (which relocates the AI when
 * quest score, then gold, stops advancing) is exercised here implicitly — it is
 * active for every combo and must never false-fire and derail an otherwise
 * winning run. Its pure scoring function is unit-tested directly in
 * tests/game/floor-progress-score.test.ts.
 *
 * To recalibrate, run `npm run ai:winrate-sweep -- --seeds 1-N --weapons sword,
 * bow,baseball-bat` and set each weapon floor below its measured rate by a noise
 * margin. Bow runs simulate the full frame budget and are markedly slower in
 * wall time than sword/bat.
 *
 * ## Assertions are on deterministic *game* time, never wall time
 *
 * `gameTimeMs` is simulated time and is identical on every machine; wall-clock
 * time is not (Windows dev box vs. ubuntu CI runner differ by 2–3x). The gate
 * asserts on `gameTimeMs < 6 min` so cross-platform CPU differences can never
 * flake it. `maxFrames` is capped just past the AI budget so a
 * regression that *fails* to clear ends deterministically and quickly instead
 * of grinding to the 100k-frame default.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FLOOR1_TIME_BUDGET_MS,
  GATE_MAX_FRAMES,
  GATE_SEEDS,
  GATE_WALL_TIME_CAP_MS,
  GATE_WEAPONS,
} from '../../scripts/agent/perf/floor1-gate-sample.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
} from '../../src/shared/quest-types.js';

/**
 * The sample constants ({@link GATE_SEEDS}, {@link GATE_WEAPONS},
 * {@link GATE_MAX_FRAMES}, {@link FLOOR1_TIME_BUDGET_MS}) live in
 * `scripts/agent/perf/floor1-gate-sample.ts` rather than here, so the
 * gameplay-neutrality fingerprint (`npm run perf:fingerprint`) provably covers
 * the exact runs this blocking gate enforces. Editing them there changes what
 * CI gates on.
 */
const HEADLESS_WALL_TIME_CAP_MS = GATE_WALL_TIME_CAP_MS;
const MAX_FRAMES = GATE_MAX_FRAMES;

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
 * weapon and the gate asserts a **sampled win-RATE** per weapon, never that a
 * hand-picked set of comfortable seeds each clears. This is a contiguous prefix
 * (seeds 1..N) so it cannot be gamed by cherry-picking the easy ones — adding a
 * failing seed in range lowers the rate exactly as it should (AGENTS.md r13).
 *
 * Measured 2026-07-11 after the ranged NPC-approach fix over seeds 1–100:
 * sword 91%, bow 94%, bat 89%. Over the gated 1–8 prefix: sword 7/8 (88%),
 * bow 8/8 (100%), bat 7/8 (88%). Thresholds below sit under measured so a
 * single prefix loss does not fail CI, while a real regression still trips it.
 */
const SAMPLE_SEEDS = GATE_SEEDS;

/**
 * Per-weapon minimum win-rate. Floors sit one loss below the measured 1–8 rates
 * so a single seed regression remains tolerable, while multiple losses trip CI.
 * The bow's 87.5% floor is the closest representable threshold to the 90% broad
 * target in an eight-seed deterministic sample.
 */
const MIN_WIN_RATE: Readonly<Record<string, number>> = {
  sword: 0.75,
  bow: 0.875,
  'baseball-bat': 0.75,
};

/**
 * Per-combo wall-clock budget for the `beforeAll` that runs the whole weapon
 * sample. Generous because a bow run simulates the entire ~19.8k-frame budget and
 * is several times slower in wall time than a sword/bat clear, and the sample is
 * N seeds (CI runners are 2–3x slower than a dev box). Correctness is asserted on
 * deterministic *game* time, not this wall-clock guard, so a comfortable margin
 * cannot cause flakes.
 */
const HEADLESS_HOOK_TIMEOUT_MS = 8 * 180_000;

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
 * subject to noisy-neighbour jitter — and the win-rate sample now includes
 * losing seeds that run the *entire* ~19.8k–21.8k-frame budget (~35–37s on a dev
 * box, ~3x on CI), so this budget is deliberately loose (~4x the slowest full
 * run) to **never flake**, while still sitting far below the ~30x blowup it
 * guards against. Do **not** tighten it toward observed runtimes: that trades a
 * real regression signal for CI flakes.
 */
const HEADLESS_WALL_TIME_BUDGET_MS = 150_000;

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
    describe(`${weapon} · win-rate over seeds 1–${SAMPLE_SEEDS.length}`, () => {
      const runs = new Map<number, RunStats>();

      beforeAll(async () => {
        for (const seed of SAMPLE_SEEDS) {
          runs.set(seed, await clearFloor1(seed, weapon));
        }
      }, HEADLESS_HOOK_TIMEOUT_MS);

      it(`wins at least ${Math.round((MIN_WIN_RATE[weapon] ?? 0) * 100)}% of the sample`, () => {
        const wins: number[] = [];
        const fails: string[] = [];
        for (const seed of SAMPLE_SEEDS) {
          const s = runs.get(seed)!;
          if (isOfficialWin(s, FLOOR1_TIME_BUDGET_MS)) {
            wins.push(seed);
          } else {
            fails.push(
              `${seed}:${s.outcome}@${(s.gameTimeMs / 1000).toFixed(0)}s lv${s.finalLevel}`,
            );
          }
        }
        const rate = wins.length / SAMPLE_SEEDS.length;
        const floor = MIN_WIN_RATE[weapon] ?? 0;
        expect(
          rate,
          `[${weapon}] win-rate ${(rate * 100).toFixed(0)}% (${wins.length}/${SAMPLE_SEEDS.length}) ` +
            `below ${(floor * 100).toFixed(0)}% floor — failures: [${fails.join(', ')}]`,
        ).toBeGreaterThanOrEqual(floor);
      });

      it('every winning run finishes all quests and shows real progression', () => {
        for (const seed of SAMPLE_SEEDS) {
          const s = runs.get(seed)!;
          if (!isOfficialWin(s, FLOOR1_TIME_BUDGET_MS)) continue;
          for (const questId of REQUIRED_QUEST_IDS) {
            expect(
              s.quests.questLogCompletions[questId],
              `[seed ${seed} · ${weapon}] won but quest "${questId}" incomplete`,
            ).toBeTypeOf('number');
          }
          expect(s.finalFloor).toBeGreaterThanOrEqual(1);
          expect(s.finalLevel).toBeGreaterThanOrEqual(1);
          expect(s.combat.totalKills).toBeGreaterThan(0);
        }
      });

      it('stays within the wall-time budget per run (perf-regression guard)', () => {
        for (const seed of SAMPLE_SEEDS) {
          const s = runs.get(seed)!;
          expect(
            s.wallTimeMs,
            `[seed ${seed} · ${weapon}] ${(s.wallTimeMs / 1000).toFixed(1)}s wall over ` +
              `${s.totalFrames} frames — over the ${HEADLESS_WALL_TIME_BUDGET_MS / 1000}s ` +
              `perf-regression budget (coarse blowup guard, not an SLA)`,
          ).toBeLessThan(HEADLESS_WALL_TIME_BUDGET_MS);
        }
      });
    });
  }
});
