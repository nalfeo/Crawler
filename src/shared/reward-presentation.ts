/**
 * reward-presentation — pure types + intensity scoring for the deterministic
 * reward-opening UX (achievement `lootBox`/`equipment` boxes and Floor 2 boss
 * chests).
 *
 * This module NEVER grants, generates, or mutates anything. It only:
 * 1. Describes a snapshot of an ALREADY-resolved, ALREADY-granted reward
 *    ({@link ResolvedRewardPresentation}) so a presentation layer can redisplay
 *    exactly what was granted — including after a reload — without ever
 *    re-rolling or re-touching the canonical bundle/claim data.
 * 2. Computes a deterministic "excitement" score/bucket from tier + (for
 *    equipment) the actual highest granted rarity, per the hard UX contract:
 *    intensity scales independently with box tier AND actual highest item
 *    rarity (e.g. a tier-2 Common reward is visually less intense than a
 *    tier-2 Uncommon reward).
 *
 * `lootBox` rewards (Floor 1 achievements only) always grant Common-rarity
 * crafting materials (see `LOOT_BOX_MATERIAL_COUNT_BY_TIER` /
 * `FLOOR1_COMMON_CRAFTING_MATERIALS` in achievements.ts) — rarity is constant,
 * so their excitement scales by `LootBoxTier` alone. `equipment` rewards
 * (Floor 2 achievements + boss chests) scale by BOTH `EquipmentRewardTier` and
 * the highest `GeneratedEquipmentRarity` among the granted instances.
 */
import { LOOT_BOX_TIERS, type LootBoxTier } from './achievements.js';
import {
  type EquipmentRewardTier,
  type GeneratedEquipmentInstanceKey,
  type GeneratedEquipmentRarity,
} from './generated-equipment-types.js';

/**
 * A snapshot of an already-resolved, already-granted reward, captured purely
 * for redisplay by the presentation layer. Building one of these never rolls
 * any RNG and never re-invokes a claim/grant function — every field here is
 * copied verbatim from a prior successful claim result (or read back from
 * data that claim already committed).
 */
export type ResolvedRewardPresentation =
  | {
      readonly kind: 'lootBox';
      readonly tier: LootBoxTier;
      readonly gold: number;
      readonly materials: readonly string[];
    }
  | {
      readonly kind: 'equipment';
      readonly tier: EquipmentRewardTier;
      readonly instanceKeys: readonly GeneratedEquipmentInstanceKey[];
    };

const GENERATED_EQUIPMENT_RARITY_ORDER: Readonly<Record<GeneratedEquipmentRarity, number>> = {
  common: 0,
  uncommon: 1,
  rare: 2,
};

/**
 * Highest rarity among a set of granted equipment instance rarities. Returns
 * `null` for an empty input (a malformed/empty grant — callers should treat
 * this as a fail-closed signal, never default to a guessed rarity).
 */
export function highestGeneratedEquipmentRarity(
  rarities: readonly GeneratedEquipmentRarity[],
): GeneratedEquipmentRarity | null {
  if (rarities.length === 0) {
    return null;
  }
  return rarities.reduce((best, rarity) =>
    GENERATED_EQUIPMENT_RARITY_ORDER[rarity] > GENERATED_EQUIPMENT_RARITY_ORDER[best]
      ? rarity
      : best,
  );
}

/** Four discrete excitement buckets driving visual intensity in the renderer. */
export type RewardExcitementBucket = 'modest' | 'notable' | 'exciting' | 'legendary';

/**
 * Deterministic excitement result. `tierWeight`/`rarityWeight` are exposed
 * alongside the collapsed `score`/`bucket` so a later consumer (e.g. an audio
 * hook slice) can distinguish which axis drove the intensity rather than only
 * seeing the combined bucket.
 */
export interface RewardExcitement {
  /** 0..1, normalized position of the box tier within its own tier scale. */
  readonly tierWeight: number;
  /** 0..1, normalized rarity weight. Always 0 for `lootBox` (rarity is constant). */
  readonly rarityWeight: number;
  /** 0..1 combined score used to pick `bucket`. */
  readonly score: number;
  readonly bucket: RewardExcitementBucket;
}

const LOOT_BOX_TIER_WEIGHT: Readonly<Record<LootBoxTier, number>> = Object.freeze(
  Object.fromEntries(
    LOOT_BOX_TIERS.map((tier, index) => [tier, index / (LOOT_BOX_TIERS.length - 1)]),
  ) as Record<LootBoxTier, number>,
);

// Explicit per-tier weights for equipment-reward excitement scoring. Values
// are fixed (not dynamically derived from EQUIPMENT_REWARD_TIERS.length) so
// that adding tier4 for boss chests does not silently re-normalize existing
// tier2/tier3 weights and break existing excitement contracts.
// tier1: 0 (common-only, lowest excitement)
// tier2: 0.5 (common/uncommon, mid range)
// tier3: 1.0 (uncommon-dominant, highest for achievements)
// tier4: 1.0 (boss chests — uncommon/rare; same weight as tier3 since the
//             excitement difference between tier3 and tier4 comes from rarity)
const EQUIPMENT_TIER_WEIGHT: Readonly<Record<EquipmentRewardTier, number>> = Object.freeze({
  tier1: 0,
  tier2: 0.5,
  tier3: 1.0,
  tier4: 1.0,
});

const EQUIPMENT_RARITY_WEIGHT: Readonly<Record<GeneratedEquipmentRarity, number>> = {
  common: 0,
  uncommon: 0.5,
  rare: 1,
};

/**
 * 0..1 rarity weight for a single granted equipment instance, using the exact
 * same table `computeEquipmentExcitement` averages into its score — the
 * single source of truth so a later per-item consumer (e.g. the audio-cue
 * escalation reducer) stays numerically consistent with the visual bucket
 * instead of re-deriving its own rarity scale.
 */
export function equipmentRarityWeight(rarity: GeneratedEquipmentRarity): number {
  return EQUIPMENT_RARITY_WEIGHT[rarity];
}

function bucketFromScore(score: number): RewardExcitementBucket {
  if (score >= 0.75) return 'legendary';
  if (score >= 0.5) return 'exciting';
  if (score >= 0.25) return 'notable';
  return 'modest';
}

/** Excitement for a Floor 1 `lootBox` reward — scales by tier alone. */
export function computeLootBoxExcitement(tier: LootBoxTier): RewardExcitement {
  const tierWeight = LOOT_BOX_TIER_WEIGHT[tier];
  return { tierWeight, rarityWeight: 0, score: tierWeight, bucket: bucketFromScore(tierWeight) };
}

/**
 * Excitement for an `equipment` reward (Floor 2 achievements + boss chests) —
 * scales by BOTH tier and the actual highest granted rarity, averaged. This
 * satisfies the hard example: tier2+common = (0.5+0)/2 = 0.25 "notable",
 * strictly less intense than tier2+uncommon = (0.5+0.5)/2 = 0.5 "exciting".
 *
 * Boss chests resolve at `tier4` with 85% Uncommon / 15% Rare (PLAN.md §E3-C),
 * so they land in the "legendary" excitement bucket: tier4+uncommon = 0.75,
 * tier4+rare = 1.0 (see `src/game/boss-chest-resolver.ts`).
 */
export function computeEquipmentExcitement(
  tier: EquipmentRewardTier,
  highestRarity: GeneratedEquipmentRarity,
): RewardExcitement {
  const tierWeight = EQUIPMENT_TIER_WEIGHT[tier];
  const rarityWeight = EQUIPMENT_RARITY_WEIGHT[highestRarity];
  const score = (tierWeight + rarityWeight) / 2;
  return { tierWeight, rarityWeight, score, bucket: bucketFromScore(score) };
}

/**
 * Compute excitement directly from a {@link ResolvedRewardPresentation} plus
 * the resolved rarities of its granted equipment instances (for `equipment`
 * presentations — callers look these up via the generated-equipment registry,
 * which is outside this pure module's dependency surface). Returns `null` if
 * an `equipment` presentation has no resolvable rarities (malformed/empty
 * grant) — callers must treat that as a fail-closed signal.
 */
export function computeRewardExcitement(
  presentation: ResolvedRewardPresentation,
  grantedRarities: readonly GeneratedEquipmentRarity[],
): RewardExcitement | null {
  if (presentation.kind === 'lootBox') {
    return computeLootBoxExcitement(presentation.tier);
  }
  const highest = highestGeneratedEquipmentRarity(grantedRarities);
  if (highest === null) {
    return null;
  }
  return computeEquipmentExcitement(presentation.tier, highest);
}
