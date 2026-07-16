import type { GameWorld } from '../../core/world.js';
import { xpRequiredForLevel } from '../../shared/xpMath.js';

/**
 * Raise the player to a deterministic level baseline by seeding the matching XP
 * threshold and unspent stat points. Safe to call repeatedly: lower/equal targets
 * are ignored.
 */
export function applyStartPlayerLevel(world: GameWorld, targetLevel: number): void {
  const level = Math.max(1, Math.floor(targetLevel));
  if (level <= 1) {
    return;
  }
  const previousLevel = Math.max(1, world.playerLevel.level);
  if (previousLevel >= level) {
    return;
  }
  const levelsGained = level - previousLevel;
  world.playerLevel.level = level;
  world.playerLevel.xp = Math.max(world.playerLevel.xp, xpRequiredForLevel(level));
  world.playerLevel.unspentPoints += levelsGained * world.playerLevel.pointsPerLevel;
}
