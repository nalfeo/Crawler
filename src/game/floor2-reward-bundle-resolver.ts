import {
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS,
  RARITY_EFFECT_BUDGET,
  type EquipmentRewardTier,
  type GeneratedEquipmentRarity,
  type GeneratedEquipmentRewardBundleV1,
} from '../shared/generated-equipment-types.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import { WeaponType } from '../shared/constants.js';
import type { GameWorld } from '../core/world.js';
import { createGeneratedEquipmentRegistryTransaction } from '../core/generated-equipment-registry.js';
import { getActiveWeapon } from './weaponSystem.js';
import {
  generateEquipmentInstance,
  getGeneratedEquipmentBaseAffinity,
  generatedEquipmentBaseHasNonArmorStatBonus,
} from './generated-equipment-generator.js';

/**
 * Resolver version. Included in every derived RNG substream key so a future
 * change to the resolution algorithm produces a distinct, non-colliding stream
 * even for the same run key + achievement.
 */
export const REWARD_BUNDLE_RESOLVER_VERSION = 'v1';

export type RewardBundleBuildAffinity = 'magic' | 'physical';

/**
 * The three generated-equipment rarities the affinity-alignment contract
 * ({@link REWARD_BUNDLE_AFFINITY_PROB}) is defined over. A single tiered
 * bundle resolves exactly ONE of these rarities (per its tier's allowed pool,
 * see {@link EQUIPMENT_REWARD_TIER_RARITIES}) — this constant is retained for
 * the affinity-probability contract and threshold tests, not to imply every
 * bundle contains all three.
 */
export const REWARD_BUNDLE_RARITIES: readonly GeneratedEquipmentRarity[] =
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES;

/**
 * Per-rarity probability that a rarity's item is drawn from the affinity-ALIGNED
 * base pool (vs the non-aligned pool). Exactly Common 25% / Uncommon 50% /
 * Rare 75% per the Floor 2 equipment spec.
 */
export const REWARD_BUNDLE_AFFINITY_PROB: Readonly<Record<GeneratedEquipmentRarity, number>> =
  Object.freeze({
    common: 0.25,
    uncommon: 0.5,
    rare: 0.75,
  });

export class RewardBundleResolutionError extends Error {
  constructor(
    readonly code:
      | 'no-run-key'
      | 'empty-aligned-pool'
      | 'empty-nonaligned-pool'
      | 'illegal-base'
      | 'illegal-effect-budget',
    message: string,
  ) {
    super(message);
    this.name = 'RewardBundleResolutionError';
  }
}

/**
 * Pure alignment decision from a single RNG roll in [0, 1). Extracted so exact
 * threshold behaviour (`< prob`) can be asserted deterministically at the exact
 * boundary values — an empirical frequency test can never prove exactness.
 */
export function alignmentFromRoll(roll: number, rarity: GeneratedEquipmentRarity): boolean {
  return roll < REWARD_BUNDLE_AFFINITY_PROB[rarity];
}

/** Draw a single affinity-alignment decision for `rarity` from `rng`. */
export function rollAffinityAlignment(
  rng: SeededRandom,
  rarity: GeneratedEquipmentRarity,
): boolean {
  return alignmentFromRoll(rng.next(), rarity);
}

/** Snapshot the player's current build affinity from the active weapon. */
export function resolvePlayerBuildAffinity(world: GameWorld): RewardBundleBuildAffinity {
  const weapon = getActiveWeapon(world);
  if (weapon === undefined) return 'physical';
  return weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical';
}

interface PartitionedBases {
  readonly aligned: readonly string[];
  readonly nonAligned: readonly string[];
}

function partitionBases(
  bases: readonly string[],
  playerAffinity: RewardBundleBuildAffinity,
): PartitionedBases {
  const aligned: string[] = [];
  const nonAligned: string[] = [];
  for (const baseId of bases) {
    if (getGeneratedEquipmentBaseAffinity(baseId) === playerAffinity) {
      aligned.push(baseId);
    } else {
      // Opposite affinity OR neutral bases both count as non-aligned.
      nonAligned.push(baseId);
    }
  }
  return { aligned: Object.freeze(aligned), nonAligned: Object.freeze(nonAligned) };
}

function substreamRng(
  runKey: string,
  achievementId: string,
  rarity: string,
  decision: string,
): SeededRandom {
  return new SeededRandom(
    hashStringToSeed(
      `reward-bundle:${REWARD_BUNDLE_RESOLVER_VERSION}:${runKey}:${achievementId}:${rarity}:${decision}`,
    ),
  );
}

/**
 * Weighted rarity pick for a tier's allowed rarity pool. The first entry in
 * {@link EQUIPMENT_REWARD_TIER_RARITIES} is favored at the tier's weight from
 * {@link EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS}; a single-entry pool (tier1)
 * always resolves to that one rarity with zero RNG consumption, so tier1 stays
 * fully deterministic even before the RNG substream is touched.
 */
export function rollTierRarity(
  rng: SeededRandom,
  tier: EquipmentRewardTier,
): GeneratedEquipmentRarity {
  const pool = EQUIPMENT_REWARD_TIER_RARITIES[tier];
  if (pool.length === 1) return pool[0]!;
  const roll = rng.next();
  return roll < EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS[tier] ? pool[0]! : pool[1]!;
}

/**
 * Resolve an achievement's (or boss-chest's) equipment reward into an
 * immutable, tier-scoped, single-item bundle and store it in
 * `world.generatedEquipmentRewardBundles` keyed by `achievementId`. The item's
 * rarity is drawn from {@link EQUIPMENT_REWARD_TIER_RARITIES}`[tier]` (see
 * {@link rollTierRarity}). `tier1` is common-only; `tier2`/`tier3` draw
 * {common, uncommon}; `tier4` (boss chests) draws {uncommon, rare} at 85/15.
 *
 * Determinism & isolation:
 * - Every random decision uses a bundle-specific {@link SeededRandom} derived
 *   from the run key + achievement id + rarity + decision (no `world.rng`
 *   consumption → zero contamination of the gameplay stream). Replaying the same
 *   run key + achievement + player affinity + tier yields an identical instance.
 * - Player level and build affinity are snapshotted once up front.
 *
 * Atomicity & fail-closed:
 * - Generation runs into a scratch registry transaction; the live registry is
 *   only mutated by the final `commit()`, and the bundle map is written only
 *   after commit. Any thrown error (empty pool, illegal base, generator failure)
 *   leaves the world completely untouched.
 * - Idempotent: if a bundle already exists for `achievementId` it is returned
 *   unchanged (never re-rolled).
 */
export function resolveEquipmentRewardBundle(
  world: GameWorld,
  achievementId: string,
  bases: readonly string[],
  tier: EquipmentRewardTier,
): GeneratedEquipmentRewardBundleV1 {
  const existing = world.generatedEquipmentRewardBundles.get(achievementId);
  if (existing !== undefined) return existing;

  const runKey = world.generatedEquipmentRegistry.runKey;
  if (runKey === null) {
    throw new RewardBundleResolutionError(
      'no-run-key',
      `Cannot resolve reward bundle for ${achievementId}: registry has no run key`,
    );
  }

  // Enforce the reward rarity contract structurally against the ambient
  // generation policy, scoped to the rarities this tier can actually draw
  // (tier1/2/3 never draw `rare`; tier4 draws uncommon+rare). A legal-but-
  // non-default policy could otherwise silently violate the reward contract.
  const effectUnits = world.generatedEquipmentRegistry.generationPolicy.rarityEffectUnits;
  for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
    if (effectUnits[rarity] > RARITY_EFFECT_BUDGET[rarity]) {
      throw new RewardBundleResolutionError(
        'illegal-effect-budget',
        `Registry effect-unit budget for ${rarity} (${effectUnits[rarity]}) exceeds the reward rarity contract (${RARITY_EFFECT_BUDGET[rarity]}) for tier ${tier}`,
      );
    }
  }

  // Enforce the Common rarity contract structurally when 'common' is in the
  // tier's rarity pool: the Common item spreads its base's inherent stat
  // bonuses verbatim with zero effect units, so any candidate base carrying a
  // non-armor stat bonus would violate "Common has no non-armor stat bonus".
  // Tiers that never draw Common (e.g. tier4 — uncommon/rare only) skip this
  // check since the constraint only applies to Common-rarity items.
  if (EQUIPMENT_REWARD_TIER_RARITIES[tier].includes('common')) {
    for (const baseId of bases) {
      if (generatedEquipmentBaseHasNonArmorStatBonus(baseId)) {
        throw new RewardBundleResolutionError(
          'illegal-base',
          `Reward base ${baseId} has an inherent non-armor stat bonus, violating the Common rarity contract`,
        );
      }
    }
  }

  const playerAffinity = resolvePlayerBuildAffinity(world);
  const { aligned, nonAligned } = partitionBases(bases, playerAffinity);
  if (aligned.length === 0) {
    throw new RewardBundleResolutionError(
      'empty-aligned-pool',
      `Reward bases for ${achievementId} have no ${playerAffinity}-aligned candidate`,
    );
  }
  if (nonAligned.length === 0) {
    throw new RewardBundleResolutionError(
      'empty-nonaligned-pool',
      `Reward bases for ${achievementId} have no non-${playerAffinity} candidate`,
    );
  }

  const itemLevel = Math.max(1, Math.floor(world.playerLevel.level));

  const rarityRng = substreamRng(runKey, achievementId, tier, 'tier-rarity');
  const rarity = rollTierRarity(rarityRng, tier);

  const transaction = createGeneratedEquipmentRegistryTransaction(world);
  const aligns = rollAffinityAlignment(
    substreamRng(runKey, achievementId, rarity, 'alignment'),
    rarity,
  );
  const pool = aligns ? aligned : nonAligned;
  const baseRng = substreamRng(runKey, achievementId, rarity, 'base');
  const baseId = pool[baseRng.nextInt(0, pool.length - 1)]!;
  const effectsRng = substreamRng(runKey, achievementId, rarity, 'effects');
  const instance = generateEquipmentInstance(
    { generatedEquipmentRegistry: transaction.registry, rng: effectsRng },
    { baseId, itemLevel, rarity },
    { rng: effectsRng, allowedEffectKinds: ['stat'] },
  );

  // Generated successfully — publish the registry state, then record the
  // bundle. Both are no-throw so the pair is effectively atomic.
  transaction.commit();
  const bundle: GeneratedEquipmentRewardBundleV1 = Object.freeze({
    schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
    achievementId,
    tier,
    instanceKeys: Object.freeze([instance.instanceId]),
  });
  world.generatedEquipmentRewardBundles.set(achievementId, bundle);
  return bundle;
}
