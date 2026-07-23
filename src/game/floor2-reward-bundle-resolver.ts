import {
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES,
  RARITY_EFFECT_BUDGET,
  type GeneratedEquipmentInstanceKey,
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
 * The three rarities every resolved bundle always contains, in canonical order.
 * A bundle is NEVER empty (Alternative-1 design: fixed 3-item bundle with
 * conditional per-rarity affinity alignment).
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
 * Resolve an achievement's equipment reward into an immutable 3-item bundle
 * (Common + Uncommon + Rare) and store it in `world.generatedEquipmentRewardBundles`
 * keyed by `achievementId`.
 *
 * Determinism & isolation:
 * - Every random decision uses a bundle-specific {@link SeededRandom} derived
 *   from the run key + achievement id + rarity + decision (no `world.rng`
 *   consumption → zero contamination of the gameplay stream). Replaying the same
 *   run key + achievement + player affinity yields identical instances.
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
  // generation policy. The generator draws each rarity's effect count from
  // `policy.rarityEffectUnits`, which is only validated to be in [0, 2] per
  // rarity — a legal-but-non-default policy (e.g. Common 1, Uncommon 2) would
  // silently produce a Common with a non-armor stat or an Uncommon with two
  // effects, violating "Common: no non-armor stat bonus / Uncommon: at most one
  // minor boost / Rare: up to two". Fail closed unless the policy budget is
  // within the reward contract (the shipped default {0,1,2} always passes).
  const effectUnits = world.generatedEquipmentRegistry.generationPolicy.rarityEffectUnits;
  if (
    effectUnits.common > RARITY_EFFECT_BUDGET.common ||
    effectUnits.uncommon > RARITY_EFFECT_BUDGET.uncommon ||
    effectUnits.rare > RARITY_EFFECT_BUDGET.rare
  ) {
    throw new RewardBundleResolutionError(
      'illegal-effect-budget',
      `Registry effect-unit budget {common:${effectUnits.common}, uncommon:${effectUnits.uncommon}, rare:${effectUnits.rare}} exceeds the reward rarity contract {common:${RARITY_EFFECT_BUDGET.common}, uncommon:${RARITY_EFFECT_BUDGET.uncommon}, rare:${RARITY_EFFECT_BUDGET.rare}}`,
    );
  }

  // Enforce the Common rarity contract structurally: the Common item spreads its
  // base's inherent stat bonuses verbatim and is generated with zero effect
  // units, so any candidate base carrying a non-armor stat bonus could violate
  // "Common has no non-armor stat bonus". Fail closed if any base does.
  for (const baseId of bases) {
    if (generatedEquipmentBaseHasNonArmorStatBonus(baseId)) {
      throw new RewardBundleResolutionError(
        'illegal-base',
        `Reward base ${baseId} has an inherent non-armor stat bonus, violating the Common rarity contract`,
      );
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

  const transaction = createGeneratedEquipmentRegistryTransaction(world);
  const instanceKeys: GeneratedEquipmentInstanceKey[] = [];
  for (const rarity of REWARD_BUNDLE_RARITIES) {
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
    instanceKeys.push(instance.instanceId);
  }

  // All three generated successfully — publish the registry state, then record
  // the bundle. Both are no-throw so the pair is effectively atomic.
  transaction.commit();
  const bundle: GeneratedEquipmentRewardBundleV1 = Object.freeze({
    schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
    achievementId,
    instanceKeys: Object.freeze(instanceKeys),
  });
  world.generatedEquipmentRewardBundles.set(achievementId, bundle);
  return bundle;
}
