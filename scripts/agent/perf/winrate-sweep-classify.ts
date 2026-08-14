/**
 * Pure, side-effect-free run classification for the win-rate sweep.
 *
 * Extracted into its own module (away from `winrate-sweep.ts`, which runs the
 * sweep at import time in worker mode) so the classification logic can be
 * unit-tested without spawning a sweep process.
 *
 * The separation of "outcome victory" from "official (tournament) win" is the
 * core of issue #1146: any run whose terminal outcome is `victory` is a win for
 * win-rate purposes; victories that exceeded the active-time budget are
 * separately flagged as slow/below-target clears rather than treated as losses.
 */
import { isOfficialWin } from '../../../src/game/ai/scoring.js';
import type { RunStats } from '../../../src/game/ai/types.js';
import { getActiveTimeBudgetMs } from '../../../src/game/ai/floor-run-budget.js';

export interface SweepRunClassification {
  /** True if the run ended in victory, regardless of active-time budget. */
  outcomeVictory: boolean;
  /**
   * True if the run is an official (tournament) win: a victory whose
   * safe-room-credited active time is under this floor's declared budget
   * (`implemented.winBudgetMs` in the floor manifest). For a floor that
   * declares no budget this is identical to `outcomeVictory`.
   */
  officialWin: boolean;
  /**
   * True if the run achieved victory but exceeded the active-time budget —
   * a "slow clear". A slow victory increments the outcome win count and this
   * flag, but never the loss count.
   */
  slowVictory: boolean;
}

/**
 * Classify a single sweep run into outcome-win / official-win / slow-victory.
 *
 * The active-time budget is resolved per floor from the manifest, so slow-clear
 * detection works on any budgeted floor rather than only Floor 1. A floor that
 * declares no budget keeps the prior behavior: official win = raw victory, and
 * no run on it can be classified slow.
 */
export function classifySweepRun(stats: RunStats, floorId: string): SweepRunClassification {
  const outcomeVictory = stats.outcome === 'victory';
  const budgetMs = getActiveTimeBudgetMs(floorId);
  const officialWin = budgetMs === null ? outcomeVictory : isOfficialWin(stats, budgetMs);
  const slowVictory = outcomeVictory && !officialWin;
  return { outcomeVictory, officialWin, slowVictory };
}
