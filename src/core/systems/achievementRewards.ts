/**
 * Achievement reward claiming (reveal-only).
 *
 * Lives in core so both the engine panel and game systems can drive claims
 * without crossing layer boundaries. Opening a reward only marks it claimed and
 * surfaces the reward def for display — no loot is granted yet.
 */
import { query } from 'bitecs';
import { Player } from '../components.js';
import type { GameWorld } from '../world.js';
import {
  getAchievementById,
  type AchievementCatalogRegistry,
  type AchievementReward,
} from '../../shared/achievements.js';
import {
  claimGeneratedEquipmentRewardBundle,
  type ClaimedRewardBundleEntry,
} from './equipmentSystem.js';

export type ClaimAchievementResult =
  | {
      readonly ok: true;
      readonly reward: AchievementReward;
      /** Present only for equipment rewards: the instances transferred to the bag. */
      readonly grantedEquipment?: readonly ClaimedRewardBundleEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'locked' | 'alreadyClaimed' | 'grantFailed';
    };

/** True once the player has opened an unlocked achievement's reward this run. */
export function isAchievementClaimed(world: GameWorld, achievementId: string): boolean {
  return world.achievements.claimedIds.has(achievementId);
}

/**
 * Open the reward for an unlocked achievement.
 *
 * For non-equipment rewards this is reveal-only: it marks the achievement
 * claimed and returns the reward def for display. For `equipment` rewards it
 * additionally transfers the pre-resolved reward bundle's instances into the
 * player's bag via {@link claimGeneratedEquipmentRewardBundle} — it NEVER invokes
 * the generator (the bundle was resolved once at unlock time). The transfer is
 * validated fail-closed: if it cannot complete atomically the achievement is not
 * marked claimed (`grantFailed`), so the claim stays retryable and exact-once.
 * Claiming is idempotent: a second call returns `alreadyClaimed`.
 */
export function claimAchievementReward(
  world: GameWorld,
  achievementId: string,
  registry?: AchievementCatalogRegistry,
): ClaimAchievementResult {
  const achievement = registry
    ? getAchievementById(achievementId, registry)
    : getAchievementById(achievementId);
  if (!achievement) {
    return { ok: false, reason: 'unknown' };
  }
  if (!world.achievements.unlockedIds.has(achievementId)) {
    return { ok: false, reason: 'locked' };
  }
  if (world.achievements.claimedIds.has(achievementId)) {
    return { ok: false, reason: 'alreadyClaimed' };
  }

  if (achievement.reward.type === 'equipment') {
    const playerEid = query(world.ecs, [Player])[0];
    if (playerEid === undefined) {
      return { ok: false, reason: 'grantFailed' };
    }
    const grant = claimGeneratedEquipmentRewardBundle(world, playerEid, achievementId);
    if (!grant.ok) {
      return { ok: false, reason: 'grantFailed' };
    }
    world.achievements.claimedIds.add(achievementId);
    return { ok: true, reward: achievement.reward, grantedEquipment: grant.granted };
  }

  world.achievements.claimedIds.add(achievementId);
  return { ok: true, reward: achievement.reward };
}
