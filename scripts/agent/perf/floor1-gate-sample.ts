/**
 * Single source of truth for the **Floor-1 gate sample** — the (seed, weapon)
 * matrix and frame budget that the blocking headless completion gate runs.
 *
 * This lives outside the test file so the gate
 * (`tests/headless/floor1-completion.test.ts`) and the gameplay-neutrality
 * fingerprint (`scripts/agent/perf/sim-fingerprint.ts`) provably cover the same
 * runs. Duplicating these constants would let the fingerprint silently drift out
 * of lockstep with CI and start certifying a sample nobody actually gates on.
 *
 * Changing anything here changes what CI enforces. Do that deliberately.
 */
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../../src/game/ai/floor1-run-budget.js';

/**
 * Deterministic seeds, as a **contiguous prefix** (1..N) so the sample cannot be
 * gamed by hand-picking comfortable seeds — any failing seed in range drags the
 * win-rate down exactly as it should (AGENTS.md r12).
 */
export const GATE_SEEDS: readonly number[] = Array.from({ length: 8 }, (_, i) => i + 1);

/**
 * Floor-1 starter weapons covering fundamentally different combat styles: a
 * tight-range full-damage blade, a leading ranged projectile, and a knockback
 * tip-sweet-spot bludgeon.
 */
export const GATE_WEAPONS: readonly string[] = ['sword', 'bow', 'baseball-bat'];

/** The AI's active-time budget for clearing Floor 1, in simulated game time. */
export const FLOOR1_TIME_BUDGET_MS = FLOOR1_ACTIVE_TIME_BUDGET_MS;

/**
 * Frame cap, set just past the AI budget so a run that fails to clear still
 * terminates deterministically rather than spinning to an arbitrary limit.
 */
export const GATE_MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;

/**
 * Wall-clock hard stop for a single run. Not a correctness assertion — purely a
 * runaway guard, deliberately far above any real runtime.
 */
export const GATE_WALL_TIME_CAP_MS = 30 * 60 * 1000;
