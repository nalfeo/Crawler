/**
 * AI run scoring function.
 *
 * Combines three metrics in strict priority order:
 *   1. Level completion (victory)  — binary, most valuable
 *   2. XP efficiency per level     — total XP / max(1, finalLevel)
 *   3. Gold collected              — tiebreaker
 *
 * The final score is a single comparable float so hill-climbing can rank runs
 * without knowing game-specific balancing constants:
 *
 *   score = victoryBonus + xpEfficiency * XP_WEIGHT + totalGold * GOLD_WEIGHT
 *
 * Weight scales are chosen so the ordering invariants hold across expected
 * headless run ranges:
 *   - A comparable run with a victory bonus beats one without it.
 *   - XP efficiency dominates gold unless the gold difference is enormous
 *     (GOLD_WEIGHT is 100× smaller than XP_WEIGHT).
 *
 * Passing a `maxGameTimeMs` budget lets the scorer penalise slow clears so
 * hill-climbing favours efficient play over brute-force attrition.
 */
import type { RunStats } from './types.js';

/** Contribution of a victory to the total score. Large enough to dominate. */
const VICTORY_BONUS = 1_000_000;

/**
 * Per-unit weight for XP efficiency (xp / level).
 * Typical values sit in the hundreds, so the raw XP-efficiency contribution
 * stays well below VICTORY_BONUS.
 */
const XP_WEIGHT = 10;

/** Per-unit weight for gold. 100× smaller than XP_WEIGHT. */
const GOLD_WEIGHT = 0.1;

/**
 * Time-efficiency bonus weight (0 = disabled).
 * Applied as `TIME_BONUS_WEIGHT * (1 - gameTimeMs / maxGameTimeMs)` when
 * `maxGameTimeMs` is provided and a victory is recorded. This nudges the
 * optimiser toward faster clears among equally-scoring configs.
 */
const TIME_BONUS_WEIGHT = 10_000;

export interface ScoreBreakdown {
  /** Composite score (higher = better). */
  score: number;
  /** Whether the run ended in victory. */
  victory: boolean;
  /** XP / max(1, level) efficiency metric. */
  xpEfficiency: number;
  /** Gold held at run end. */
  totalGold: number;
  /** Time-efficiency bonus (0 if no victory or no budget provided). */
  timeBonus: number;
}

/**
 * Score a single headless run.
 *
 * @param stats      - RunStats returned by `runHeadless`.
 * @param maxGameTimeMs - Optional budget for time-efficiency bonus. Pass the
 *   same value you used for `maxFrames × GAME.DELTA_MS` (e.g. 300 000 ms for a
 *   300s budget). When omitted, the time-efficiency bonus is 0.
 */
export function scoreRun(stats: RunStats, maxGameTimeMs?: number): ScoreBreakdown {
  const victory = stats.outcome === 'victory';
  const xpEfficiency = stats.totalXp / Math.max(1, stats.finalLevel);
  const totalGold = stats.totalGold;

  let timeBonus = 0;
  if (victory && maxGameTimeMs != null && maxGameTimeMs > 0) {
    const timeFraction = Math.min(1, stats.gameTimeMs / maxGameTimeMs);
    timeBonus = TIME_BONUS_WEIGHT * (1 - timeFraction);
  }

  const score =
    (victory ? VICTORY_BONUS : 0) + timeBonus + xpEfficiency * XP_WEIGHT + totalGold * GOLD_WEIGHT;

  return { score, victory, xpEfficiency, totalGold, timeBonus };
}

/**
 * Aggregate scores across multiple seeds by computing the mean composite
 * score. Callers should convert errored runs into zero-score failure
 * breakdowns before passing them here.
 */
export function aggregateScores(breakdowns: ScoreBreakdown[]): {
  meanScore: number;
  victoryRate: number;
  meanXpEfficiency: number;
  meanGold: number;
} {
  if (breakdowns.length === 0) {
    return { meanScore: 0, victoryRate: 0, meanXpEfficiency: 0, meanGold: 0 };
  }

  const n = breakdowns.length;
  const meanScore = breakdowns.reduce((acc, b) => acc + b.score, 0) / n;
  const victoryRate = breakdowns.filter((b) => b.victory).length / n;
  const meanXpEfficiency = breakdowns.reduce((acc, b) => acc + b.xpEfficiency, 0) / n;
  const meanGold = breakdowns.reduce((acc, b) => acc + b.totalGold, 0) / n;

  return { meanScore, victoryRate, meanXpEfficiency, meanGold };
}
