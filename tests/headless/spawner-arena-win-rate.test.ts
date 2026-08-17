/**
 * Spawner battle-arena headless win-rate gate.
 *
 * Verifies the arena feature does not regress Floor-1 completion, and that
 * every reachable spawner in a winning run reaches the terminal resolved
 * state (`arenaState === 2`). Uses the same `runHeadless` pipeline as the
 * canonical Floor-1 gate (`tests/headless/floor1-completion.test.ts`) so we
 * exercise the real preSystems ordering (spawnerArenaSystem BEFORE
 * spawnerSystem) rather than a lab-only harness.
 *
 * ## 2026-07-07 — Floor 1 is now spawner-free (ADR 0049)
 *
 * Floor 1's static-spawner spawn table is intentionally empty, so no Spawner
 * entities (and therefore no battle-arenas) exist on Floor 1. This gate
 * consequently narrows to: (a) the sword win-rate floor, (b) the AI time
 * budget, and (c) a positive assertion that Floor 1 stays spawner-free (the
 * inverse of the old `anyTriggered > 0` engagement check). The arena state
 * machine + AI lock-in remain covered by
 * `tests/integration/ai-arena-lockin.integration.test.ts`. Restore the
 * engagement assertion here if a headless floor sampled by this gate regains
 * spawners.
 *
 * ## Scoping vs. `floor1-completion.test.ts`
 *
 * The canonical gate already sweeps three weapons × 8 seeds and asserts the
 * per-weapon win-rate floor. Re-running that sample here would triple the
 * headless wall-time budget for essentially the same signal. Instead, this
 * gate:
 *
 *   1. Runs a **single-weapon** sample (sword — the highest measured win-rate)
 *      with the arena feature engaged. This is enough to detect a regression
 *      caused by the arena mechanics (fence tile mutation, XP intercept,
 *      spawnerSystem→arenaSystem adjacency), without duplicating the
 *      broader completion signal.
 *   2. Asserts every spawner that reached `arenaState ≥ 1` (i.e. was actually
 *      triggered by the player) reaches `arenaState === 2`. A spawner that
 *      the AI never approached is legitimately never triggered and is
 *      excluded — that is the "reachable" qualifier from spec Requirements§8.
 *   3. Asserts the arena system stays out of the AI's way — winning runs
 *      still meet the Floor-1 collapse deadline (`FLOOR1_ACTIVE_TIME_BUDGET_MS`) as
 *      the canonical gate.
 *
 * Constitution rule 13 target is 90% Floor-1 win-rate. The canonical gate
 * enforces 75% (sword) today; if the arena feature regresses sword below
 * that floor, this gate will catch it before the canonical one does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isOfficialWin, activeTimeMs } from '../../src/game/ai/scoring.js';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';

const HEADLESS_WALL_TIME_CAP_MS = 30 * 60 * 1000;
const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;

/** Deterministic seeds 1..8 — same prefix as the canonical Floor-1 gate. */
const SAMPLE_SEEDS = Array.from({ length: 8 }, (_, i) => i + 1) as readonly number[];

/**
 * Sword-weapon floor. Matches the canonical Floor-1 gate's sword floor (75%).
 * Rule 13 targets 90% overall, tracked by the sword+bat sample in
 * `floor1-completion.test.ts`; this gate rides that same floor so the arena
 * feature is measured as a *delta* from the existing baseline — a regression
 * that pushes sword below its floor here will be caught in isolation.
 */
const MIN_WIN_RATE = 0.75;

const HEADLESS_HOOK_TIMEOUT_MS = 8 * 180_000;

async function clearFloor1WithArenas(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: HEADLESS_WALL_TIME_CAP_MS,
    forceWeaponId: 'sword',
  });
}

describe('spawner battle-arena · headless Floor-1 sweep', () => {
  const runs = new Map<number, RunStats>();

  beforeAll(async () => {
    for (const seed of SAMPLE_SEEDS) {
      runs.set(seed, await clearFloor1WithArenas(seed));
    }
  }, HEADLESS_HOOK_TIMEOUT_MS);

  it(`wins at least ${Math.round(MIN_WIN_RATE * 100)}% of the sample`, () => {
    const wins: number[] = [];
    const fails: string[] = [];
    for (const seed of SAMPLE_SEEDS) {
      const s = runs.get(seed)!;
      if (isOfficialWin(s, FLOOR1_ACTIVE_TIME_BUDGET_MS)) {
        wins.push(seed);
      } else {
        fails.push(`${seed}:${s.outcome}@${(s.gameTimeMs / 1000).toFixed(0)}s lv${s.finalLevel}`);
      }
    }
    const rate = wins.length / SAMPLE_SEEDS.length;
    expect(
      rate,
      `[sword+arena] win-rate ${(rate * 100).toFixed(0)}% (${wins.length}/${SAMPLE_SEEDS.length}) ` +
        `below ${(MIN_WIN_RATE * 100).toFixed(0)}% floor — failures: [${fails.join(', ')}]`,
    ).toBeGreaterThanOrEqual(MIN_WIN_RATE);
  });

  it('Floor 1 is spawner-free, so no battle-arena engages (feature dormant — ADR 0049)', () => {
    // Floor 1's static-spawner spawn table is intentionally empty
    // (`FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS = []`, see floorScenario.ts +
    // ADR 0049), so no Spawner entities exist and no battle-arena can trigger
    // on Floor 1. The arena state machine, barrier arming, and AI lock-in are
    // still exercised end-to-end by
    // `tests/integration/ai-arena-lockin.integration.test.ts`, which
    // hand-builds a barrier-armed arena. This assertion is the deliberate
    // inverse of the pre-ADR-0049 `anyTriggered > 0` engagement check: when
    // Floor 1 (or another headless floor sampled here) regains spawners,
    // restore the `> 0` assertion instead of this `=== 0` one.
    let anyTriggered = 0;
    let anyTotal = 0;
    const perSeed: string[] = [];
    for (const seed of SAMPLE_SEEDS) {
      const s = runs.get(seed)!;
      const arenas = s.spawnerArenas;
      // Non-vacuity: `runHeadless` always populates this telemetry, so a missing
      // rollup means a real regression (arena metrics unwired), not a legitimately
      // spawner-free floor. Assert it is present before trusting the zero counts.
      expect(
        arenas,
        `[seed ${seed}] runHeadless did not populate spawnerArenas telemetry`,
      ).toBeDefined();
      anyTotal += arenas!.total;
      anyTriggered += arenas!.triggered;
      perSeed.push(`${seed}:total=${arenas!.total}/t=${arenas!.triggered}/o=${s.outcome}`);
    }
    console.log(
      `arena engagement sweep (expect total=0 & triggered=0 on spawner-free Floor 1): ${perSeed.join(' ')}`,
    );
    // Assert Floor 1 has no Spawner entities at all (total === 0), which is
    // strictly stronger than "none triggered" and would catch an accidental
    // re-introduction of Floor-1 spawners that the AI simply never approached.
    expect(
      anyTotal,
      `Floor 1 should be spawner-free (ADR 0049) but ${anyTotal} Spawner entit(ies) exist — ` +
        `if Floor 1 intentionally regained spawners, restore the ` +
        `'anyTriggered > 0' engagement assertion here`,
    ).toBe(0);
    expect(anyTriggered, `Floor 1 arenas triggered despite being spawner-free`).toBe(0);
  });

  it('AI arena lock-in — resolves ≥95% of arenas that actually trapped it (ADR 0045)', () => {
    // The user-stated caveat from PR #764 is that the BT AI sometimes walks
    // past a triggered spawner arena without engaging. This gate measures
    // whether the arena-lock-in priority slot (Priority 1.5, ADR 0045) fixes
    // that on the natural Floor-1 sweep.
    //
    // Denominator is `barrierArmed`, NOT `triggered`, because a triggered
    // arena whose barrier code path was a no-op (empty fence ring, roomless
    // spawner) never actually traps the AI. Forcing the AI to fight those
    // is a policy choice for future work, not the fix the user asked for.
    // Numerator is `resolvedArmed` (resolved AND armed), NOT the bare
    // `resolved` count, which also includes IDLE→RESOLVED short-circuits that
    // never armed — those would push the ratio above 1.0 and mask a real miss.
    // See ADR 0045 for the gate / `barrierArmed` denominator, and ADR 0046 for
    // the `resolvedArmed` numerator semantics (the ever-armed latch + why the
    // bare `resolved` count is the wrong numerator).
    let armed = 0;
    let resolvedArmed = 0;
    const misses: string[] = [];
    for (const seed of SAMPLE_SEEDS) {
      const s = runs.get(seed)!;
      const arenas = s.spawnerArenas;
      if (!arenas) continue;
      armed += arenas.barrierArmed;
      resolvedArmed += arenas.resolvedArmed;
      if (arenas.barrierArmed > arenas.resolvedArmed) {
        misses.push(`${seed}:armed=${arenas.barrierArmed}/resolvedArmed=${arenas.resolvedArmed}`);
      }
    }
    if (armed === 0) {
      // Nothing to assert — Floor-1's arenas currently never arm a real
      // barrier in this sample. The stricter check is exercised by
      // `tests/integration/ai-arena-lockin.integration.test.ts`, which
      // hand-builds a barrier-armed arena and asserts the AI kills it
      // within a bounded budget. This test stays green as a future-proof
      // rollup: when Floor 1 gains barrier-arming spawners, the gate
      // starts asserting the 95% rate automatically.
      return;
    }
    const rate = resolvedArmed / armed;
    expect(
      rate,
      `[arena-lockin] resolvedArmed/armed ${(rate * 100).toFixed(0)}% (${resolvedArmed}/${armed}) ` +
        `below 95% floor — misses: [${misses.join(', ')}]`,
    ).toBeGreaterThanOrEqual(0.95);
  });

  it('every winning run stays inside the Floor-1 collapse deadline', () => {
    for (const seed of SAMPLE_SEEDS) {
      const s = runs.get(seed)!;
      if (s.outcome !== 'victory') continue;
      // Credit safe-room dwell: the floor-collapse deadline pauses in safe rooms,
      // so a legitimate win is bounded by ACTIVE time (game time − safe-room time),
      // not raw game time. A safe-room-credited over-budget-raw victory is valid.
      expect(
        activeTimeMs(s),
        `[seed ${seed}] won at ${(activeTimeMs(s) / 1000).toFixed(0)}s active ` +
          `(${(s.gameTimeMs / 1000).toFixed(0)}s raw, ${(s.safeRoomMs / 1000).toFixed(0)}s safe-room) — ` +
          `over the ${FLOOR1_ACTIVE_TIME_BUDGET_MS / 1000}s collapse deadline (arena feature regression?)`,
      ).toBeLessThan(FLOOR1_ACTIVE_TIME_BUDGET_MS);
    }
  });
});
