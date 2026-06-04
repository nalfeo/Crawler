/**
 * Pure XP math helpers — no game state, no imports.
 * Formulas:
 *   xpThresholdForLevel(n) = floor(XP.BASE_PER_LEVEL * XP.SCALING_FACTOR^n)
 *   xpRequiredForLevel(n)  = cumulative sum of thresholds 0..n-1
 */

const BASE_PER_LEVEL = 10;
const SCALING_FACTOR = 1.15;
const MAX_LEVEL_LOOKUP = 1000;
const xpRequiredCache: number[] = [0];

/**
 * XP required to advance from level `n` to level `n+1`.
 * Level 0 requires BASE_PER_LEVEL XP.
 */
export function xpThresholdForLevel(level: number): number {
  return Math.floor(BASE_PER_LEVEL * Math.pow(SCALING_FACTOR, level));
}

/**
 * Cumulative lifetime XP needed to be at `level`.
 * xpRequiredForLevel(0) = 0
 * xpRequiredForLevel(1) = xpThresholdForLevel(0)
 * xpRequiredForLevel(2) = xpThresholdForLevel(0) + xpThresholdForLevel(1)
 */
export function xpRequiredForLevel(level: number): number {
  if (level < 0) return 0;

  while (xpRequiredCache.length <= level) {
    const nextLevel = xpRequiredCache.length;
    const prevTotal = xpRequiredCache[nextLevel - 1] ?? 0;
    xpRequiredCache.push(prevTotal + xpThresholdForLevel(nextLevel - 1));
  }

  return xpRequiredCache[level] ?? 0;
}

/**
 * Returns the level corresponding to a given lifetime XP amount.
 * Uses a binary search capped at 1000 levels for safety.
 */
export function levelForXp(xp: number): number {
  let low = 0;
  let high = MAX_LEVEL_LOOKUP;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (xpRequiredForLevel(mid) <= xp) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}
