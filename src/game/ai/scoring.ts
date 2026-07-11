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
import type { QuestState } from '../../shared/quest-types.js';
import { QUEST_PROGRESS_SCORE_WEIGHT } from './bt-ai-tuning.js';

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
 * Milliseconds of safe-room dwell above which a run is *flagged* for review.
 * The floor-collapse deadline pauses while the player is in a safe room, so a
 * legitimate clear can spend some time there — but an inordinate amount (the
 * maintainer's Floor-1 rule of thumb: > 60s total) usually signals a
 * navigation stall parked near a safe room rather than intentional play. This
 * is a DIAGNOSTIC threshold surfaced in sweep leaderboards, never a hard gate.
 */
export const SAFE_ROOM_FLAG_MS = 60_000;

/**
 * Collapse-relevant "active" time: wall game time minus the safe-room dwell
 * during which the floor-collapse deadline is paused (see `floorScenario` — the
 * deadline extends by one frame for each frame the player is in a safe room).
 * This is the time that actually counts against the Floor-1 budget. `safeRoomMs`
 * is optional so callers reading older artifacts (before the field existed)
 * fall back to raw game time.
 */
export function activeTimeMs(stats: { gameTimeMs: number; safeRoomMs?: number }): number {
  return Math.max(0, stats.gameTimeMs - (stats.safeRoomMs ?? 0));
}

/**
 * The single source of truth for an *official* Floor-1 win: a victory whose
 * collapse-relevant active time (safe-room dwell excluded) is under the budget.
 *
 * This replaces the scattered `outcome === 'victory' && gameTimeMs < budget`
 * checks so every sweep, A/B harness, and headless gate credits safe-room time
 * identically — matching the game's own collapse-deadline pause. Scoring
 * (`scoreRun`) deliberately stays on RAW `gameTimeMs` for its time bonus so the
 * search gradient never rewards idling in a safe room.
 */
export function isOfficialWin(
  stats: { outcome: RunStats['outcome']; gameTimeMs: number; safeRoomMs?: number },
  budgetMs: number,
): boolean {
  return stats.outcome === 'victory' && activeTimeMs(stats) < budgetMs;
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

/**
 * Pure, near-monotonic "floor progress" score over a set of quests + gold.
 *
 * It advances on ANY real quest objective tick (rats killed, items fetched,
 * talk latches), quest completion, or gold payout, but stays frozen during a
 * knockback/kite deadlock where the player jitters in place landing no killing
 * blows — exactly the signal the quest-progress watchdog needs to catch a
 * deadlock the spatial/HP watchdogs miss.
 *
 * Quest score is weighted ({@link QUEST_PROGRESS_SCORE_WEIGHT}) far above gold
 * so a shop purchase (an objective latches +; gold dips by the price) still
 * reads as net forward progress, while gold re-anchors the ready-to-buy farming
 * stage that quest counters alone leave static. Extracted as a free function so
 * the scoring is unit-testable without constructing a full world.
 */
export function computeFloorProgressScore(quests: Iterable<QuestState>, gold: number): number {
  let questScore = 0;
  for (const quest of quests) {
    questScore += 1; // each accepted quest
    if (quest.status === 'complete') {
      questScore += 100;
    }
    for (const value of Object.values(quest.progress)) {
      questScore += value; // counter objectives (kills, fetch pickups…)
    }
    for (const flag of Object.values(quest.done)) {
      if (flag) {
        questScore += 10; // latched multistep objectives
      }
    }
  }
  return questScore * QUEST_PROGRESS_SCORE_WEIGHT + gold;
}
