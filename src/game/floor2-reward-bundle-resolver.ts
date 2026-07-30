import {
  ACHIEVEMENT_EQUIPMENT_REWARD_TIERS,
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
  generatedEquipmentInstanceHasNonArmorStatBonus,
} from './generated-equipment-generator.js';
import {
  FLOOR2_REWARD_POOL_STABLE_IDS,
  FLOOR2_REWARD_POOL_WEAPON_IDS,
} from '../shared/data/floor2-reward-pool.js';

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

/**
 * The tiers achievement JSON can actually assign, in
 * {@link EQUIPMENT_REWARD_TIER_RARITIES} terms — `common`/`uncommon`/`rare`
 * achievement tiers map to `tier1`/`tier2`/`tier3` via
 * `FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER` (shared/achievements.ts).
 * `tier4` is boss-chest-only (see `boss-chest-resolver.ts`'s
 * `BOSS_CHEST_REWARD_BASE_IDS`, a disjoint bases list) and never draws from
 * {@link FLOOR2_REWARD_POOL_STABLE_IDS}, so it is deliberately excluded from
 * this authoring check.
 */
const BUILD_AFFINITIES: readonly RewardBundleBuildAffinity[] = ['physical', 'magic'];

/** Weapon/non-weapon + affinity composition of a tier/rarity's eligible pool. */
export interface Floor2RewardPoolRarityComposition {
  readonly total: number;
  readonly weapons: number;
  readonly nonWeapons: number;
  readonly physicalAligned: number;
  readonly magicAligned: number;
  readonly neutral: number;
}

export type Floor2RewardPoolTierEligibilityReport = Readonly<
  Record<
    EquipmentRewardTier,
    Readonly<Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>>
  >
>;

/** Rarity-eligible subset of `bases` for `rarity`, mirroring the exact filter
 * `resolveEquipmentRewardBundle` applies at selection time (see its Common
 * rarity contract comment above). Exported so authoring validation and tests
 * both derive eligibility from the SAME rule the resolver actually uses —
 * never a second, hand-maintained copy of the filter. */
export function rarityEligibleBaseIds(
  bases: readonly string[],
  rarity: GeneratedEquipmentRarity,
): readonly string[] {
  return rarity === 'common'
    ? bases.filter((baseId) => !generatedEquipmentBaseHasNonArmorStatBonus(baseId))
    : bases;
}

/**
 * Compute, for every achievement-reachable tier × rarity pair, the eligible
 * subset of `bases` (via {@link rarityEligibleBaseIds}) and its weapon/
 * non-weapon/affinity composition (per {@link ACHIEVEMENT_EQUIPMENT_REWARD_TIERS}).
 * `weaponIds` classifies weapon vs non-weapon; every non-weapon base is
 * reported as-is (the current data model has no armor-vs-accessory category
 * — see `equipment-slots.ts`'s `SlotDefinition` — so "non-weapon" is the
 * finest queryable split; `neutral` further separates non-aligned bases that
 * are magic/physical-neutral from a true opposite-affinity base).
 *
 * Calling {@link getGeneratedEquipmentBaseAffinity} on every supplied base ID
 * means an unresolvable ID throws `unknown-base` (from
 * `resolveGeneratedEquipmentBase`) the moment this function runs — bad/unknown
 * content fails loudly here, not silently.
 */
export function computeFloor2RewardPoolTierEligibility(
  bases: readonly string[],
  weaponIds: ReadonlySet<string>,
): Floor2RewardPoolTierEligibilityReport {
  const report = {} as Record<
    EquipmentRewardTier,
    Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>
  >;
  for (const tier of ACHIEVEMENT_EQUIPMENT_REWARD_TIERS) {
    const rarityRow = {} as Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>;
    for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
      const eligible = rarityEligibleBaseIds(bases, rarity);
      let weapons = 0;
      let physicalAligned = 0;
      let magicAligned = 0;
      let neutral = 0;
      for (const baseId of eligible) {
        if (weaponIds.has(baseId)) weapons += 1;
        const affinity = getGeneratedEquipmentBaseAffinity(baseId);
        if (affinity === 'physical') physicalAligned += 1;
        else if (affinity === 'magic') magicAligned += 1;
        else neutral += 1;
      }
      rarityRow[rarity] = Object.freeze({
        total: eligible.length,
        weapons,
        nonWeapons: eligible.length - weapons,
        physicalAligned,
        magicAligned,
        neutral,
      });
    }
    report[tier] = Object.freeze(rarityRow);
  }
  return Object.freeze(report);
}

export class Floor2RewardPoolAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Floor2RewardPoolAuthoringError';
  }
}

/**
 * Fail-loud, deterministic authoring/content check over the centralized
 * Floor 2 reward pool, run unconditionally at module load (see the call at
 * the bottom of this file) — mirroring the eager `validateRewardPool()` /
 * `validateBasicLeatherBases()` pattern in the sibling data modules:
 *
 * 1. **Every base resolves.** {@link computeFloor2RewardPoolTierEligibility}
 *    calls {@link getGeneratedEquipmentBaseAffinity} on every eligible base,
 *    which throws `unknown-base` for any unresolvable ID — this function
 *    does not catch or suppress that throw, so a misspelled/removed base in
 *    the pool fails loudly the moment the module loads, not only when a
 *    specific achievement happens to roll it at runtime.
 * 2. **Every achievement-reachable tier × rarity × player-build pool is
 *    non-empty, for BOTH the aligned and non-aligned partitions.** This is
 *    the load-time counterpart of `resolveEquipmentRewardBundle`'s runtime
 *    `empty-aligned-pool` / `empty-nonaligned-pool` throw: it catches a
 *    content regression (e.g. removing the last physical-aligned Common
 *    base) immediately, rather than only when a specific seed/tier/build
 *    combination happens to be exercised.
 * 3. **Every pool base is legal for at least one achievement rarity/tier.**
 *    The Common exclusion only ever narrows candidacy (see
 *    `rarityEligibleBaseIds`) — `uncommon` never filters — so a base that is
 *    excluded from Common remains fully eligible at `tier2`'s `uncommon`
 *    rarity. This check asserts that union is exhaustive: no base is
 *    permanently benched from every achievement draw.
 *
 * This throws {@link Floor2RewardPoolAuthoringError} (never returns a
 * silently-narrowed or empty result) the instant an authored-content
 * regression makes any of the above false, so a content change is caught at
 * import time rather than discovered later as a runtime `empty-*-pool`
 * throw or, worse, a narrowed-but-still-selectable pool that quietly
 * recreates the old repeated-four-bases defect.
 */
export function validateFloor2RewardPoolTierEligibility(
  bases: readonly string[] = FLOOR2_REWARD_POOL_STABLE_IDS,
  weaponIds: ReadonlySet<string> = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS),
): Floor2RewardPoolTierEligibilityReport {
  const report = computeFloor2RewardPoolTierEligibility(bases, weaponIds);

  for (const tier of ACHIEVEMENT_EQUIPMENT_REWARD_TIERS) {
    for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
      const eligible = rarityEligibleBaseIds(bases, rarity);
      for (const playerAffinity of BUILD_AFFINITIES) {
        const { aligned, nonAligned } = partitionBases(eligible, playerAffinity);
        if (aligned.length === 0) {
          throw new Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: tier ${tier} rarity ${rarity} has no ` +
              `${playerAffinity}-aligned candidate (pool size ${bases.length}, eligible ${eligible.length})`,
          );
        }
        if (nonAligned.length === 0) {
          throw new Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: tier ${tier} rarity ${rarity} has no ` +
              `non-${playerAffinity} candidate (pool size ${bases.length}, eligible ${eligible.length})`,
          );
        }
      }
    }
  }

  // Every base must be legal for at least one achievement rarity/tier. The
  // Common exclusion is the ONLY filter `rarityEligibleBaseIds` ever applies
  // (see its body), so the uncommon-eligible set (unfiltered `bases`) is
  // exactly `bases` itself — this loop exists so a FUTURE filter change
  // (e.g. an uncommon-scoped exclusion) cannot silently bench a base without
  // this check catching it, not because today's rule could ever fail it.
  const uncommonEligible = new Set(rarityEligibleBaseIds(bases, 'uncommon'));
  const neverEligible = bases.filter((baseId) => !uncommonEligible.has(baseId));
  if (neverEligible.length > 0) {
    throw new Floor2RewardPoolAuthoringError(
      `Floor 2 reward pool authoring check failed: base(s) permanently ineligible for every ` +
        `achievement rarity/tier: ${neverEligible.join(', ')}`,
    );
  }

  return report;
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

  // Common rarity contract: a base's inherent stat bonuses are part of its
  // fixed, source-independent identity (see
  // `generatedEquipmentBaseHasNonArmorStatBonus`'s doc comment in
  // generated-equipment-generator.ts) — the SAME base must produce the SAME
  // stats whether it is drawn here or sold by the Quartermaster. So instead
  // of generating an instance and then normalizing/stripping its output
  // (which would make a base's stats depend on acquisition source — not
  // allowed), rarity is rolled FIRST, and bases carrying an inherent
  // non-armor stat bonus are excluded from *candidacy* only for a Common
  // draw specifically (Common contributes zero rarity-effect units, see
  // {@link RARITY_EFFECT_BUDGET}`.common === 0`, so a base's inherent bonus
  // would otherwise be the item's only non-armor stat). Such bases remain
  // fully eligible — bonus intact — for Uncommon/Rare draws of this same
  // tier. The broad reward pool is unioned from every generated-equipment
  // catalog and is not curated per-achievement, so this filter (rather than
  // pool curation) is what keeps every rarity's candidate set legal. See
  // `rarityEligibleBaseIds` (the single source of truth for this exact
  // filter, shared with the module-load authoring validation below) and
  // `validateFloor2RewardPoolTierEligibility` (the authoring-time proof that
  // this filter never empties an achievement-reachable pool).
  const rarityRng = substreamRng(runKey, achievementId, tier, 'tier-rarity');
  const rarity = rollTierRarity(rarityRng, tier);

  const rarityEligibleBases = rarityEligibleBaseIds(bases, rarity);

  const playerAffinity = resolvePlayerBuildAffinity(world);
  const { aligned, nonAligned } = partitionBases(rarityEligibleBases, playerAffinity);
  if (aligned.length === 0) {
    throw new RewardBundleResolutionError(
      'empty-aligned-pool',
      `Reward bases for ${achievementId} have no ${playerAffinity}-aligned candidate at rarity ${rarity}`,
    );
  }
  if (nonAligned.length === 0) {
    throw new RewardBundleResolutionError(
      'empty-nonaligned-pool',
      `Reward bases for ${achievementId} have no non-${playerAffinity} candidate at rarity ${rarity}`,
    );
  }

  const itemLevel = Math.max(1, Math.floor(world.playerLevel.level));

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

  // Defense in depth: the eligibility filter above should make this
  // unreachable, but assert the actual output rather than trusting the
  // filter silently — a future data change (e.g. a base's `statBonuses`
  // changing) should fail loudly here instead of shipping an illegal Common
  // item.
  if (rarity === 'common' && generatedEquipmentInstanceHasNonArmorStatBonus(instance)) {
    throw new RewardBundleResolutionError(
      'illegal-base',
      `Generated Common instance for base ${baseId} has a non-armor stat bonus, violating the Common rarity contract`,
    );
  }

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

// Run the authoring/content check unconditionally at module load — mirroring
// `validateRewardPool()` (floor2-reward-pool.ts) and `validateBasicLeatherBases()`
// (floor2-basic-leather-bases.ts). Any regression (an unresolvable base, or a
// tier/rarity/build combination left with an empty aligned or non-aligned
// pool) throws the instant this module is imported, not only when a specific
// achievement/seed/build happens to exercise it at runtime.
validateFloor2RewardPoolTierEligibility();
