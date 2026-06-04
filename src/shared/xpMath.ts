/**
 * Pure XP math helpers — no game state, no imports.
 * Formulas:
 *   xpThresholdForLevel(n) = floor(XP.BASE_PER_LEVEL * XP.SCALING_FACTOR^n)
 *   xpRequiredForLevel(n)  = cumulative sum of thresholds 0..n-1
 */

const BASE_PER_LEVEL = 10;
const SCALING_FACTOR = 1.15;

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
  let total = 0;
  for (let i = 0; i < level; i++) {
    total += xpThresholdForLevel(i);
  }
  return total;
}

/**
 * Returns the level corresponding to a given lifetime XP amount.
 * Uses binary search capped at 1000 levels for safety.
 */
export function levelForXp(xp: number): number {
  let level = 0;
  while (xpRequiredForLevel(level + 1) <= xp) {
    level++;
    if (level >= 1000) break;
  }
  return level;
}
