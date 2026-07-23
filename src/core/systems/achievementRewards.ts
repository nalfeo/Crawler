/**
 * Achievement reward claiming (reveal-only for non-lootBox rewards).
 *
 * Lives in core so both the engine panel and game systems can drive claims
 * without crossing layer boundaries. Opening a reward marks it claimed and
 * surfaces the reward def for display. `equipment` and `lootBox` rewards
 * additionally transfer a pre-resolved bundle's contents (equipment
 * instances, or gold + common crafting materials, respectively) into the
 * player's bag/gold — both bundles were resolved ONCE at unlock time (see
 * `resolveEquipmentRewardBundle` / `resolveLootBoxRewardBundle`). Claiming
 * NEVER rolls any RNG itself — generation happens only at unlock (resolution),
 * never at claim, load, or presentation.
 */
import { query } from 'bitecs';
import { Player } from '../components.js';
import type { GameWorld } from '../world.js';
import {
  getAchievementById,
  LOOT_BOX_GOLD_BY_TIER,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
  FLOOR1_COMMON_CRAFTING_MATERIALS,
  type AchievementCatalogRegistry,
  type AchievementReward,
} from '../../shared/achievements.js';
import { addItem } from '../../shared/inventory.js';
import {
  claimGeneratedEquipmentRewardBundle,
  type ClaimedRewardBundleEntry,
} from './equipmentSystem.js';

export interface GrantedLootBox {
  readonly gold: number;
  readonly materials: readonly string[];
}

export type ClaimAchievementResult =
  | {
      readonly ok: true;
      readonly reward: AchievementReward;
      /** Present only for equipment rewards: the instances transferred to the bag. */
      readonly grantedEquipment?: readonly ClaimedRewardBundleEntry[];
      /** Present only for lootBox rewards: the gold + materials actually granted. */
      readonly grantedLootBox?: GrantedLootBox;
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
 * For `directorMessage`/`item`/`none` rewards this is reveal-only: it marks the
 * achievement claimed and returns the reward def for display. For `equipment`
 * rewards it additionally transfers the pre-resolved reward bundle's instances
 * into the player's bag via {@link claimGeneratedEquipmentRewardBundle} — it
 * NEVER invokes the generator (the bundle was resolved once at unlock time).
 * For `lootBox` rewards (Floor 1 only) it reads the pre-resolved bundle from
 * `world.lootBoxRewardBundles` and applies its exact gold (scaled by tier)
 * plus common crafting materials — structurally NEVER equipment, since the
 * `lootBox` reward variant carries no equipment fields, and never re-rolled
 * (the bundle was resolved once at unlock time, mirroring equipment).
 *
 * All grants are validated fail-closed BEFORE any mutation: if a grant cannot
 * complete atomically the achievement is not marked claimed (`grantFailed`),
 * so the claim stays retryable and exact-once — no partial grant is ever
 * possible. Claiming is idempotent: a second call returns `alreadyClaimed`.
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
    const grant = claimGeneratedEquipmentRewardBundle(
      world,
      playerEid,
      achievementId,
      achievement.reward.tier,
    );
    if (!grant.ok) {
      return { ok: false, reason: 'grantFailed' };
    }
    world.achievements.claimedIds.add(achievementId);
    return { ok: true, reward: achievement.reward, grantedEquipment: grant.granted };
  }

  if (achievement.reward.type === 'lootBox') {
    const playerEid = query(world.ecs, [Player])[0];
    if (playerEid === undefined) {
      return { ok: false, reason: 'grantFailed' };
    }
    const bag = world.inventories.get(playerEid);
    if (!bag) {
      return { ok: false, reason: 'grantFailed' };
    }
    const bundle = world.lootBoxRewardBundles.get(achievementId);
    if (!bundle) {
      return { ok: false, reason: 'grantFailed' };
    }
    // Tier cross-check (fail-closed, defense in depth): the bundle's own tier
    // must match the achievement definition's CURRENT declared tier at claim
    // time, mirroring the same check `claimGeneratedEquipmentRewardBundle`
    // performs for equipment bundles — so a bundle resolved under a
    // stale/edited catalog tier can never be claimed under a different tier's
    // contract.
    if (bundle.tier !== achievement.reward.tier) {
      return { ok: false, reason: 'grantFailed' };
    }
    // Content guard (fail-closed, defense in depth, BEFORE any mutation): a
    // freshly-resolved bundle always carries the canonical per-tier gold and
    // material count with catalog-valid material ids (see
    // `resolveLootBoxRewardBundle`), but the LIVE bundle in `world.lootBoxRewardBundles`
    // is never re-validated against that canonical shape after resolution —
    // mirroring `claimGeneratedEquipmentRewardBundle`'s validate-then-commit
    // ordering, verify every field here so a corrupted/forged live bundle can
    // never leak partial gold/materials or throw mid-mutation (which would
    // otherwise leave gold or some materials granted while the achievement
    // stays unclaimed and the bundle already deleted).
    if (bundle.gold !== LOOT_BOX_GOLD_BY_TIER[bundle.tier]) {
      return { ok: false, reason: 'grantFailed' };
    }
    if (bundle.materials.length !== LOOT_BOX_MATERIAL_COUNT_BY_TIER[bundle.tier]) {
      return { ok: false, reason: 'grantFailed' };
    }
    for (const itemId of bundle.materials) {
      if (!FLOOR1_COMMON_CRAFTING_MATERIALS.includes(itemId)) {
        return { ok: false, reason: 'grantFailed' };
      }
    }
    // All validation passed — commit atomically. Consume the bundle first so
    // no other code can observe a partially-granted state.
    world.lootBoxRewardBundles.delete(achievementId);
    world.playerGold += bundle.gold;
    for (const itemId of bundle.materials) {
      addItem(bag, itemId, 1);
    }
    world.achievements.claimedIds.add(achievementId);
    return {
      ok: true,
      reward: achievement.reward,
      grantedLootBox: { gold: bundle.gold, materials: bundle.materials },
    };
  }

  world.achievements.claimedIds.add(achievementId);
  return { ok: true, reward: achievement.reward };
}
