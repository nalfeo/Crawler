/**
 * Achievement reward claiming (reveal-only for `directorMessage`/`item`/`none`
 * rewards).
 *
 * Lives in core so both the engine panel and game systems can drive claims
 * without crossing layer boundaries. Opening a reward marks it claimed and
 * surfaces the reward def for display. `lootBox` rewards additionally
 * transfer a pre-resolved bundle's contents into the player's bag/gold — for
 * Floor 2's `floor2-generated-equipment` loot table, one generated-equipment
 * instance (via `claimGeneratedEquipmentRewardBundle`) when the unlock-time
 * drop roll hit, otherwise Floor 2's own richer gold + crafting materials; for
 * Floor 1's `floor1-materials` loot table, gold + common crafting materials —
 * every bundle was resolved ONCE at unlock time (see
 * `resolveEquipmentRewardBundle` / `resolveLootBoxRewardBundle`). Which payout
 * a Floor 2 achievement carries is read from which bundle map holds it, never
 * re-rolled here. Claiming NEVER rolls any RNG itself — generation happens
 * only at unlock (resolution), never at claim, load, or presentation.
 */
import { query } from 'bitecs';
import { Player } from '../components.js';
import type { GameWorld } from '../world.js';
import {
  getAchievementById,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
  FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER,
  LEGACY_TIER4_ACHIEVEMENT_BUNDLE_IDS,
  materialsTableForReward,
  materialsTableGoldForTier,
  materialsTablePool,
  type AchievementCatalogRegistry,
  type AchievementReward,
} from '../../shared/achievements.js';
import { addItem } from '../../shared/inventory.js';
import type { ResolvedRewardPresentation } from '../../shared/reward-presentation.js';
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
 * achievement claimed and returns the reward def for display. For `lootBox`
 * rewards whose `lootTable` is `floor2-generated-equipment` it additionally
 * transfers the pre-resolved reward bundle's instance into the player's bag
 * via {@link claimGeneratedEquipmentRewardBundle} — it NEVER invokes the
 * generator (the bundle was resolved once at unlock time). For `lootBox`
 * rewards whose `lootTable` is `floor1-materials` it reads the pre-resolved
 * bundle from `world.lootBoxRewardBundles` and applies its exact gold (scaled
 * by tier) plus common crafting materials — structurally NEVER equipment,
 * since the `floor1-materials` variant carries no equipment fields, and never
 * re-rolled (the bundle was resolved once at unlock time, mirroring the
 * equipment path).
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

  if (
    achievement.reward.type === 'lootBox' &&
    achievement.reward.lootTable === 'floor2-generated-equipment' &&
    world.generatedEquipmentRewardBundles.has(achievementId)
  ) {
    const playerEid = query(world.ecs, [Player])[0];
    if (playerEid === undefined) {
      return { ok: false, reason: 'grantFailed' };
    }
    // Floor 2's `lootBox` reward carries the player/content-facing
    // common/uncommon/rare tier vocabulary — translate to the resolver's
    // internal tier1-tier3 EquipmentRewardTier keyspace before calling into
    // the equipment claim path, which is unaware of the achievement-facing
    // vocabulary (ADR 0069 amendment; the resolver/claim boundary itself is
    // unchanged, see ADR 0068).
    const equipmentRewardTier = FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER[achievement.reward.tier];
    // Legacy allowance: a small set of achievements briefly shipped with tier4
    // bundles before the authored tier model tightened to tier1-tier3.
    // If the persisted bundle is tier4 AND the achievementId is in the shared
    // allowlist, pass tier4 as the expected tier so the already-generated
    // instance is claimed verbatim — no re-roll, no stat/rarity change.
    const existingBundle = world.generatedEquipmentRewardBundles.get(achievementId);
    const effectiveTier =
      existingBundle?.tier === 'tier4' && LEGACY_TIER4_ACHIEVEMENT_BUNDLE_IDS.has(achievementId)
        ? ('tier4' as const)
        : equipmentRewardTier;
    const grant = claimGeneratedEquipmentRewardBundle(
      world,
      playerEid,
      achievementId,
      effectiveTier,
    );
    if (!grant.ok) {
      return { ok: false, reason: 'grantFailed' };
    }
    world.achievements.claimedIds.add(achievementId);
    world.achievements.pendingPresentations.set(achievementId, {
      kind: 'equipment',
      tier: effectiveTier,
      instanceKeys: grant.granted.map((entry) => entry.instanceKey),
    });
    return { ok: true, reward: achievement.reward, grantedEquipment: grant.granted };
  }

  if (achievement.reward.type === 'lootBox') {
    // Either a Floor 1 `floor1-materials` reward, or a Floor 2 achievement
    // whose equipment drop roll missed at unlock and resolved Floor 2's own
    // gold+materials payout instead (see `rollFloor2AchievementEquipmentDrop`).
    // Which table's gold/pool contract applies is derived from the reward
    // itself, never from the persisted bundle.
    const materialsTable = materialsTableForReward(achievement.reward);
    const materialPool = materialsTablePool(materialsTable);
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
    if (bundle.gold !== materialsTableGoldForTier(materialsTable, bundle.tier)) {
      return { ok: false, reason: 'grantFailed' };
    }
    if (bundle.materials.length !== LOOT_BOX_MATERIAL_COUNT_BY_TIER[bundle.tier]) {
      return { ok: false, reason: 'grantFailed' };
    }
    for (const itemId of bundle.materials) {
      if (!materialPool.includes(itemId)) {
        return { ok: false, reason: 'grantFailed' };
      }
    }
    // All validation passed — commit atomically. Consume the bundle first so
    // no other code can observe a partially-granted state.
    world.lootBoxRewardBundles.delete(achievementId);
    world.playerGold += bundle.gold;
    world.goldLedger.earnedFromLootBoxes += bundle.gold;
    for (const itemId of bundle.materials) {
      addItem(bag, itemId, 1);
    }
    world.achievements.claimedIds.add(achievementId);
    const grantedLootBox: GrantedLootBox = { gold: bundle.gold, materials: bundle.materials };
    world.achievements.pendingPresentations.set(achievementId, {
      kind: 'lootBox',
      tier: bundle.tier,
      gold: grantedLootBox.gold,
      materials: grantedLootBox.materials,
    });
    return {
      ok: true,
      reward: achievement.reward,
      grantedLootBox,
    };
  }

  world.achievements.claimedIds.add(achievementId);
  return { ok: true, reward: achievement.reward };
}

/** Read (without consuming) the pending presentation snapshot, if any. */
export function getPendingAchievementRewardPresentation(
  world: GameWorld,
  achievementId: string,
): ResolvedRewardPresentation | undefined {
  return world.achievements.pendingPresentations.get(achievementId);
}

/**
 * Acknowledge (consume) an achievement's pending reward presentation once the
 * UI sequence has completed or been skipped to its end. Idempotent: calling
 * this when nothing is pending (already acknowledged, or a reward type that
 * never had one) is always a safe no-op — matching
 * {@link ../../core/systems/bossChestRewards.ts#acknowledgeBossChestReveal}'s
 * idempotent-acknowledge convention. This never re-grants or re-touches the
 * underlying claim — the grant already happened atomically in
 * {@link claimAchievementReward}.
 */
export function acknowledgeAchievementRewardPresentation(
  world: GameWorld,
  achievementId: string,
): void {
  world.achievements.pendingPresentations.delete(achievementId);
}
