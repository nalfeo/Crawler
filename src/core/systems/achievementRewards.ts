/**
 * Achievement reward claiming (reveal-only).
 *
 * Lives in core so both the engine panel and game systems can drive claims
 * without crossing layer boundaries. Opening a reward only marks it claimed and
 * surfaces the reward def for display — no loot is granted yet.
 */
import type { GameWorld } from '../world.js';
import { getAchievementById, type AchievementReward } from '../../shared/achievements.js';

export type ClaimAchievementResult =
  | { readonly ok: true; readonly reward: AchievementReward }
  | { readonly ok: false; readonly reason: 'unknown' | 'locked' | 'alreadyClaimed' };

/** True once the player has opened an unlocked achievement's reward this run. */
export function isAchievementClaimed(world: GameWorld, achievementId: string): boolean {
  return world.achievements.claimedIds.has(achievementId);
}

/**
 * Open the reward for an unlocked achievement: marks it claimed and returns the
 * reward def so the UI can reveal what was inside. Reveal-only, no loot granted.
 */
export function claimAchievementReward(
  world: GameWorld,
  achievementId: string,
): ClaimAchievementResult {
  const achievement = getAchievementById(achievementId);
  if (!achievement) {
    return { ok: false, reason: 'unknown' };
  }
  if (!world.achievements.unlockedIds.has(achievementId)) {
    return { ok: false, reason: 'locked' };
  }
  if (world.achievements.claimedIds.has(achievementId)) {
    return { ok: false, reason: 'alreadyClaimed' };
  }
  world.achievements.claimedIds.add(achievementId);
  return { ok: true, reward: achievement.reward };
}
