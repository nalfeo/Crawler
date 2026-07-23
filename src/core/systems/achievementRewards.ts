/**
 * Achievement reward claiming (reveal-only for non-lootBox rewards).
 *
 * Lives in core so both the engine panel and game systems can drive claims
 * without crossing layer boundaries. Opening a reward marks it claimed and
 * surfaces the reward def for display. `equipment` rewards additionally
 * transfer a pre-resolved bundle; `lootBox` rewards additionally grant gold +
 * common crafting materials. Grants happen ONLY at claim time — never at
 * unlock, load, or presentation.
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
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import {
  claimGeneratedEquipmentRewardBundle,
  type ClaimedRewardBundleEntry,
} from './equipmentSystem.js';

/**
 * Versioned so a future change to the loot-box grant algorithm produces a
 * distinct, non-colliding RNG stream even for the same run seed + achievement.
 */
const LOOT_BOX_GRANT_VERSION = 'v1';

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
 * Deterministically pick `count` materials (with replacement) from
 * {@link FLOOR1_COMMON_CRAFTING_MATERIALS} for a lootBox grant. Derived from
 * `world.seed` + `achievementId` (never `world.rng`), so replaying the same
 * run seed + achievement always grants the identical materials, and the
 * gameplay RNG stream is never contaminated by a reward-claim UI action.
 */
function rollLootBoxMaterials(world: GameWorld, achievementId: string, count: number): string[] {
  const rng = new SeededRandom(
    hashStringToSeed(
      `lootbox-grant:${LOOT_BOX_GRANT_VERSION}:${world.seed}:${achievementId}:materials`,
    ),
  );
  const materials: string[] = [];
  for (let i = 0; i < count; i += 1) {
    materials.push(rng.pick(FLOOR1_COMMON_CRAFTING_MATERIALS));
  }
  return materials;
}

/**
 * Open the reward for an unlocked achievement.
 *
 * For `directorMessage`/`item`/`none` rewards this is reveal-only: it marks the
 * achievement claimed and returns the reward def for display. For `equipment`
 * rewards it additionally transfers the pre-resolved reward bundle's instances
 * into the player's bag via {@link claimGeneratedEquipmentRewardBundle} — it
 * NEVER invokes the generator (the bundle was resolved once at unlock time).
 * For `lootBox` rewards (Floor 1 only) it grants gold (scaled by tier) plus a
 * tier-scaled count of common crafting materials — structurally NEVER
 * equipment, since the `lootBox` reward variant carries no equipment fields.
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
    const grant = claimGeneratedEquipmentRewardBundle(world, playerEid, achievementId);
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
    const { tier } = achievement.reward;
    const gold = LOOT_BOX_GOLD_BY_TIER[tier];
    const materialCount = LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier];
    // Fail closed BEFORE mutating anything: the material pool must be
    // non-empty (structurally guaranteed by FLOOR1_COMMON_CRAFTING_MATERIALS
    // being derived from the catalog, but re-checked here so a future catalog
    // edit that empties the pool fails the claim instead of throwing mid-grant).
    if (FLOOR1_COMMON_CRAFTING_MATERIALS.length === 0) {
      return { ok: false, reason: 'grantFailed' };
    }
    const materials = rollLootBoxMaterials(world, achievementId, materialCount);
    // Apply the grant: gold then materials, then mark claimed — all in one
    // synchronous pass so no other code can observe a partially-granted state.
    world.playerGold += gold;
    for (const itemId of materials) {
      addItem(bag, itemId, 1);
    }
    world.achievements.claimedIds.add(achievementId);
    return { ok: true, reward: achievement.reward, grantedLootBox: { gold, materials } };
  }

  world.achievements.claimedIds.add(achievementId);
  return { ok: true, reward: achievement.reward };
}
