/**
 * Permanent full-pipeline determinism guard for the melee spatial-hash broad-phase.
 *
 * The unit-level differential test
 * (`tests/ecs/melee-broadphase-determinism.test.ts`) runs the melee stage
 * immediately after `collisionSystem` with nothing in between, so it proves the
 * conversion is identical-by-construction *today*. What it structurally cannot
 * catch is a *future* pipeline change that inserts a target-moving system into
 * the `collisionSystem` -> `meleeSwingSystem` seam: that would make the
 * once-per-frame grid stale relative to a per-swing full scan and could silently
 * diverge combat outcomes (melee draws `world.rng` per qualifying hit, so hit
 * order is determinism-observable).
 *
 * This test closes that gap by driving the REAL full `runSimulationStep`
 * pipeline — the exact one the Floor 1 win-rate gate uses — twice per seed:
 * once with the grid broad-phase (default) and once forced onto the legacy
 * full-`[Health, Position]` scan via the `meleeBroadPhase` guard seam. It then
 * asserts the two runs are byte-identical. If anyone ever moves combat targets
 * between the grid build and the melee stage, the two paths diverge and this
 * test goes red — promoting the determinism-risk class into a permanent
 * deterministic check (AGENTS.md rule #10).
 *
 * Assertions are on deterministic run state only; `RunStats.wallTimeMs` (the
 * sole wall-clock field) is stripped so cross-machine timing can never flake it.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';

/**
 * Contiguous seeds (ungameable — a bad seed drags the guard red exactly as it
 * should, AGENTS.md rule #13). `sword` is forced so every run actually engages
 * in melee combat, exercising the broad-phase path (asserted non-vacuous below).
 */
const GUARD_SEEDS = [1, 2] as const;

/**
 * Enough frames for sustained melee across the opening tutorial fight and several
 * director waves without running full clears, keeping the guard fast. A divergence
 * anywhere in the run cascades into the final `RunStats`, so a partial run is a
 * sufficient — and much cheaper — witness than a full Floor 1 clear.
 */
const GUARD_MAX_FRAMES = 3000;

/**
 * Run the headless Floor 1 pipeline for a seed with the melee broad-phase either
 * on (grid, default) or off (legacy full scan). `maxWallTimeMs` is set to
 * Infinity so the ONLY run terminator is the deterministic frame cap (the default
 * 5-minute wall-clock cap is nondeterministic and could otherwise stop the two
 * runs at different frames under load). `forceWeaponId: 'sword'` swaps only the
 * equipped weapon; world generation is identical across both modes.
 */
async function runMelee(seed: number, meleeBroadPhase: boolean): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    maxFrames: GUARD_MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    forceWeaponId: 'sword',
    simulationOptions: { meleeBroadPhase },
  });
}

/** `RunStats.wallTimeMs` is the only nondeterministic field (measured wall clock). */
function stripWallTime(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

describe('melee broad-phase — full-pipeline determinism guard', () => {
  for (const seed of GUARD_SEEDS) {
    it(`grid and legacy full-scan produce byte-identical runs (seed ${seed})`, async () => {
      const grid = await runMelee(seed, true);
      const legacy = await runMelee(seed, false);

      // Non-vacuity: the forced sword must actually land melee hits, otherwise
      // the two paths would agree trivially without exercising the broad-phase.
      expect(grid.combat.damageDealt).toBeGreaterThan(0);
      expect(legacy.combat.damageDealt).toBe(grid.combat.damageDealt);

      // Identical-by-construction across the entire deterministic run summary
      // (frames, outcome, kills, damage, XP, level, health/quest metrics).
      expect(stripWallTime(legacy)).toEqual(stripWallTime(grid));
    });
  }
});
