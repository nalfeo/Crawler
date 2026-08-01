import {
  ACHIEVEMENT_EQUIPMENT_REWARD_TIERS,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS,
  RARITY_EFFECT_BUDGET,
  type AchievementEquipmentRewardTier,
  type EquipmentRewardTier,
  type GeneratedEquipmentRarity,
  type GeneratedEquipmentInstanceV1,
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

/**
 * Authored weapon draw weight for category-biased reward selection (issue #2555).
 *
 * When {@link resolveEquipmentRewardBundle} is called with a `weaponIds` set
 * this is the probability that the candidate base is drawn from the weapon
 * sub-pool rather than the non-weapon (armor/accessory) sub-pool. 25 % weapon
 * / 75 % non-weapon corrects the ~14× per-position oversupply of weapons
 * relative to armor: weapons occupy only 2 equipment slots vs 16 armor slots,
 * yet previously represented 64 % of the reward pool by raw count.
 *
 * This constant intentionally remains tunable. It ONLY applies when the caller
 * supplies a non-undefined `weaponIds` set (achievement rewards from the full
 * Floor 2 pool). Boss-chest rewards use their own disjoint pool without
 * category weighting.
 */
export const FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT = 0.25;

/**
 * Pure category decision from a single RNG roll in [0, 1). Returns `'weapon'`
 * when `roll < weaponWeight`, `'non-weapon'` otherwise. Extracted as a named
 * export so the exact `< weight` threshold can be asserted in unit tests — an
 * empirical frequency test can never prove exactness.
 */
export function _categoryFromRoll(roll: number, weaponWeight: number): 'weapon' | 'non-weapon' {
  return roll < weaponWeight ? 'weapon' : 'non-weapon';
}

export type RewardBundleBuildAffinity = 'magic' | 'physical';

/**
 * The three generated-equipment rarities the affinity-alignment contract
 * ({@link _REWARD_BUNDLE_AFFINITY_PROB}) is defined over. A single tiered
 * bundle resolves exactly ONE of these rarities (per its tier's allowed pool,
 * see {@link EQUIPMENT_REWARD_TIER_RARITIES}) — this constant is retained for
 * the affinity-probability contract and threshold tests, not to imply every
 * bundle contains all three.
 */
export const _REWARD_BUNDLE_RARITIES: readonly GeneratedEquipmentRarity[] =
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES;

/**
 * Per-rarity probability that a rarity's item is drawn from the affinity-ALIGNED
 * base pool (vs the non-aligned pool). Exactly Common 25% / Uncommon 50% /
 * Rare 75% per the Floor 2 equipment spec.
 */
export const _REWARD_BUNDLE_AFFINITY_PROB: Readonly<Record<GeneratedEquipmentRarity, number>> =
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
      | 'empty-category-pool'
      | 'illegal-effect-budget'
      | 'illegal-base',
    message: string,
  ) {
    super(message);
    this.name = 'RewardBundleResolutionError';
  }
}

export function _assertGeneratedRewardInstanceLegal(
  instance: GeneratedEquipmentInstanceV1,
  rarity: GeneratedEquipmentRarity,
): void {
  if (rarity === 'common' && generatedEquipmentInstanceHasNonArmorStatBonus(instance)) {
    throw new RewardBundleResolutionError(
      'illegal-base',
      `Generated Common instance for base ${instance.baseId} has a non-armor stat bonus, violating the Common rarity contract`,
    );
  }
}

/**
 * Pure alignment decision from a single RNG roll in [0, 1). Extracted so exact
 * threshold behaviour (`< prob`) can be asserted deterministically at the exact
 * boundary values — an empirical frequency test can never prove exactness.
 */
export function _alignmentFromRoll(roll: number, rarity: GeneratedEquipmentRarity): boolean {
  return roll < _REWARD_BUNDLE_AFFINITY_PROB[rarity];
}

/** Draw a single affinity-alignment decision for `rarity` from `rng`. */
export function _rollAffinityAlignment(
  rng: SeededRandom,
  rarity: GeneratedEquipmentRarity,
): boolean {
  return _alignmentFromRoll(rng.next(), rarity);
}

/** Snapshot the player's current build affinity from the active weapon. */
export function _resolvePlayerBuildAffinity(world: GameWorld): RewardBundleBuildAffinity {
  const weapon = getActiveWeapon(world);
  if (weapon === undefined) return 'physical';
  return weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical';
}

interface PartitionedBases {
  readonly aligned: readonly string[];
  readonly nonAligned: readonly string[];
}

/**
 * Partition `bases` into aligned (same affinity as `playerAffinity`) and
 * non-aligned pools for reward selection.
 *
 * **Non-aligned pool preference:** when neutral (non-weapon) bases exist in the
 * candidate set, the non-aligned pool is restricted to those neutrals only —
 * off-affinity weapons are excluded. This prevents magic players from spending
 * their non-aligned draws on unusable physical weapons (which dominate the pool
 * ~51:5) and gives both builds comparable wearable-gear acquisition rates.
 *
 * **Fallback:** when no neutral bases are present (e.g. a weapon-only fixture),
 * the non-aligned pool falls back to all non-aligned candidates (neutral +
 * off-affinity) so small test fixtures and boss-chest pools continue to work
 * without an `empty-nonaligned-pool` error.
 *
 * Exported with `_` prefix for unit-testing the exact partitioning contract;
 * callers outside this module should use {@link resolveEquipmentRewardBundle}.
 */
export function _partitionBases(
  bases: readonly string[],
  playerAffinity: RewardBundleBuildAffinity,
): PartitionedBases {
  const aligned: string[] = [];
  const neutral: string[] = [];
  const offAffinity: string[] = [];
  for (const baseId of bases) {
    const affinity = getGeneratedEquipmentBaseAffinity(baseId);
    if (affinity === playerAffinity) {
      aligned.push(baseId);
    } else if (affinity === 'neutral') {
      neutral.push(baseId);
    } else {
      offAffinity.push(baseId);
    }
  }
  // Prefer neutral (wearable) bases for non-aligned draws; fall back to the
  // full non-aligned set only when no neutral items are present.
  const nonAligned = neutral.length > 0 ? neutral : [...neutral, ...offAffinity];
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
    AchievementEquipmentRewardTier,
    Readonly<Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>>
  >
>;

/** Rarity-eligible subset of `bases` for `rarity`, mirroring the exact filter
 * `resolveEquipmentRewardBundle` applies at selection time (see its Common
 * rarity contract comment above). Exported so authoring validation and tests
 * both derive eligibility from the SAME rule the resolver actually uses —
 * never a second, hand-maintained copy of the filter. */
export function _rarityEligibleBaseIds(
  bases: readonly string[],
  _rarity: GeneratedEquipmentRarity,
): readonly string[] {
  // Under the decoupled model, non-armor power is affix-driven (not base-stat
  // spreading). All bases are eligible for all rarities since their inherent
  // non-armor stats are never copied into generated instances. Common generates
  // zero affix effects (RARITY_EFFECT_BUDGET.common === 0), so a Common item
  // from a base with a non-armor authoring rider simply has no non-armor stats
  // in its generated output — the rarity contract is still satisfied.
  return bases;
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
export function _computeFloor2RewardPoolTierEligibility(
  bases: readonly string[],
  weaponIds: ReadonlySet<string>,
): Floor2RewardPoolTierEligibilityReport {
  const report = {} as Record<
    AchievementEquipmentRewardTier,
    Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>
  >;
  for (const tier of ACHIEVEMENT_EQUIPMENT_REWARD_TIERS) {
    const rarityRow = {} as Record<GeneratedEquipmentRarity, Floor2RewardPoolRarityComposition>;
    for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
      const eligible = _rarityEligibleBaseIds(bases, rarity);
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

export class _Floor2RewardPoolAuthoringError extends Error {
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
export function _validateFloor2RewardPoolTierEligibility(
  bases: readonly string[] = FLOOR2_REWARD_POOL_STABLE_IDS,
  weaponIds: ReadonlySet<string> = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS),
): Floor2RewardPoolTierEligibilityReport {
  const report = _computeFloor2RewardPoolTierEligibility(bases, weaponIds);

  for (const tier of ACHIEVEMENT_EQUIPMENT_REWARD_TIERS) {
    for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
      const eligible = _rarityEligibleBaseIds(bases, rarity);
      for (const playerAffinity of BUILD_AFFINITIES) {
        const { aligned, nonAligned } = _partitionBases(eligible, playerAffinity);
        if (aligned.length === 0) {
          throw new _Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: tier ${tier} rarity ${rarity} has no ` +
              `${playerAffinity}-aligned candidate (pool size ${bases.length}, eligible ${eligible.length})`,
          );
        }
        if (nonAligned.length === 0) {
          throw new _Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: tier ${tier} rarity ${rarity} has no ` +
              `non-${playerAffinity} candidate (pool size ${bases.length}, eligible ${eligible.length})`,
          );
        }
      }
    }
  }

  // Every base must be legal for at least one achievement rarity/tier. Under
  // the decoupled model, all bases are eligible for every rarity
  // (_rarityEligibleBaseIds always returns all bases), so this check is a
  // no-op today — but it exists so a future filter change cannot silently
  // bench a base without this check catching it at import time.
  const uncommonEligible = new Set(_rarityEligibleBaseIds(bases, 'uncommon'));
  const neverEligible = bases.filter((baseId) => !uncommonEligible.has(baseId));
  if (neverEligible.length > 0) {
    throw new _Floor2RewardPoolAuthoringError(
      `Floor 2 reward pool authoring check failed: base(s) permanently ineligible for every ` +
        `achievement rarity/tier: ${neverEligible.join(', ')}`,
    );
  }

  // Category-weighted sub-pool validation: mirrors the runtime category-selection
  // path in resolveEquipmentRewardBundle, which activates whenever weaponIds is
  // defined — including an empty set. Both category pools must be non-empty so
  // neither category roll can crash at runtime. The weapon sub-pool affinity check
  // runs before the non-weapon neutrality check so both paths are independently
  // reachable: a partial weaponIds (e.g. physical-only) triggers the affinity
  // error before the neutrality guard (which operates on non-weapon bases).
  const weaponBases = bases.filter((id) => weaponIds.has(id));
  const nonWeaponBases = bases.filter((id) => !weaponIds.has(id));

  // Guard: an empty weaponIds means every weapon-category roll would crash at
  // runtime — the resolver enables category weighting for any defined weaponIds,
  // including an empty set.
  if (weaponIds.size === 0) {
    throw new _Floor2RewardPoolAuthoringError(
      `Floor 2 reward pool authoring check failed: weaponIds is empty — ` +
        `category weighting requires a non-empty weapon ID set (weapon category pool would always be empty)`,
    );
  }

  // Guard: non-empty weaponIds but no bases match means the weapon draw crashes.
  if (weaponBases.length === 0) {
    throw new _Floor2RewardPoolAuthoringError(
      `Floor 2 reward pool authoring check failed: weaponIds is non-empty (${weaponIds.size} entries) ` +
        `but no base in the supplied pool matches any weapon ID (pool size: ${bases.length})`,
    );
  }

  // Guard: an all-weapon pool means every non-weapon-category roll would crash.
  if (nonWeaponBases.length === 0) {
    throw new _Floor2RewardPoolAuthoringError(
      `Floor 2 reward pool authoring check failed: all bases in the pool are weapons — ` +
        `non-weapon category pool would always be empty for a non-weapon category roll`,
    );
  }

  // Weapon sub-pool: both affinity partitions must be non-empty per tier × rarity
  // so the category-weighted weapon draw can always apply affinity alignment.
  // (Checked before the non-weapon neutrality guard so this path is independently
  // reachable — see comment above.)
  for (const tier of ACHIEVEMENT_EQUIPMENT_REWARD_TIERS) {
    for (const rarity of EQUIPMENT_REWARD_TIER_RARITIES[tier]) {
      const eligibleWeapons = _rarityEligibleBaseIds(weaponBases, rarity);
      for (const playerAffinity of BUILD_AFFINITIES) {
        const { aligned, nonAligned } = _partitionBases(eligibleWeapons, playerAffinity);
        if (aligned.length === 0) {
          throw new _Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: weapon sub-pool for tier ${tier} ` +
              `rarity ${rarity} has no ${playerAffinity}-aligned weapon candidate`,
          );
        }
        if (nonAligned.length === 0) {
          throw new _Floor2RewardPoolAuthoringError(
            `Floor 2 reward pool authoring check failed: weapon sub-pool for tier ${tier} ` +
              `rarity ${rarity} has no non-${playerAffinity} weapon candidate`,
          );
        }
      }

      // Non-weapon sub-pool: must be non-empty per tier × rarity so the uniform
      // draw path always has at least one candidate. (nonWeaponBases is guaranteed
      // non-empty after the all-weapon guard above.)
      const eligibleNonWeapons = _rarityEligibleBaseIds(nonWeaponBases, rarity);
      if (eligibleNonWeapons.length === 0) {
        throw new _Floor2RewardPoolAuthoringError(
          `Floor 2 reward pool authoring check failed: non-weapon sub-pool for tier ${tier} ` +
            `rarity ${rarity} has no eligible candidate`,
        );
      }
    }
  }

  // Assert all non-weapon bases carry neutral affinity — the category-weighted
  // non-weapon draw path skips affinity alignment on this assumption. A future
  // non-weapon base with physical/magic affinity would silently bypass alignment.
  for (const nonWeaponBase of nonWeaponBases) {
    const affinity = getGeneratedEquipmentBaseAffinity(nonWeaponBase);
    if (affinity !== 'neutral') {
      throw new _Floor2RewardPoolAuthoringError(
        `Floor 2 reward pool authoring check failed: non-weapon base "${nonWeaponBase}" ` +
          `has affinity "${affinity}" — all non-weapon bases must be neutral for the ` +
          `category-weighted non-weapon draw path (which skips affinity alignment)`,
      );
    }
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
export function _rollTierRarity(
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
 * Category weighting (issue #2555):
 * - When `weaponIds` is provided, the draw is category-biased before affinity
 *   alignment. A `'category'` substream rolls weapon vs non-weapon at
 *   {@link FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT} (25 % weapon / 75 %
 *   non-weapon). Weapon draws apply the normal affinity-alignment step.
 *   Non-weapon draws skip affinity alignment and pick uniformly from the
 *   non-weapon sub-pool (non-weapons are all neutral — they carry no
 *   physical/magic affinity). Boss-chest callers omit `weaponIds` and
 *   receive the original uniform-with-affinity behavior.
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
  weaponIds?: ReadonlySet<string>,
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

  // Under the decoupled model, non-armor power is affix-driven. Rarity is
  // rolled first so the eligible base pool (via _rarityEligibleBaseIds) is
  // known before partition. Under this model, _rarityEligibleBaseIds returns
  // all bases regardless of rarity — Common generates zero affix effects
  // (RARITY_EFFECT_BUDGET.common === 0) but the base's non-armor authoring
  // riders are never spread into the generated instance, so no candidacy
  // filtering is needed to keep Common output rarity-contract-legal.
  const rarityRng = substreamRng(runKey, achievementId, tier, 'tier-rarity');
  const rarity = _rollTierRarity(rarityRng, tier);

  const rarityEligibleBases = _rarityEligibleBaseIds(bases, rarity);

  const playerAffinity = _resolvePlayerBuildAffinity(world);

  // Determine the final candidate pool: category-weighted when weaponIds is
  // provided, original affinity-partitioned draw otherwise.
  let pool: readonly string[];

  if (weaponIds !== undefined) {
    // Category-biased selection (issue #2555). Roll weapon vs non-weapon FIRST
    // using a dedicated substream so category decisions are independent of
    // rarity/affinity substreams and never collide with them.
    const categoryRng = substreamRng(runKey, achievementId, 'category', tier);
    const category = _categoryFromRoll(categoryRng.next(), FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT);

    const categoryBases = rarityEligibleBases.filter((id) =>
      category === 'weapon' ? weaponIds.has(id) : !weaponIds.has(id),
    );
    if (categoryBases.length === 0) {
      throw new RewardBundleResolutionError(
        'empty-category-pool',
        `Reward bases for ${achievementId} have no ${category} candidate at rarity ${rarity}`,
      );
    }

    if (category === 'weapon') {
      // Weapons carry physical/magic affinities — apply the normal alignment
      // step within the weapon sub-pool.
      const { aligned, nonAligned } = _partitionBases(categoryBases, playerAffinity);
      if (aligned.length === 0) {
        throw new RewardBundleResolutionError(
          'empty-aligned-pool',
          `Reward bases for ${achievementId} have no ${playerAffinity}-aligned weapon candidate at rarity ${rarity}`,
        );
      }
      if (nonAligned.length === 0) {
        throw new RewardBundleResolutionError(
          'empty-nonaligned-pool',
          `Reward bases for ${achievementId} have no non-${playerAffinity} weapon candidate at rarity ${rarity}`,
        );
      }
      const aligns = _rollAffinityAlignment(
        substreamRng(runKey, achievementId, rarity, 'alignment'),
        rarity,
      );
      pool = aligns ? aligned : nonAligned;
    } else {
      // Non-weapons are all neutral — skip affinity alignment and draw
      // uniformly. Using `affinity` RNG here would have no effect anyway (all
      // neutral → never aligned for any build), and skipping it keeps the
      // substream distinct so future re-runs are reproducible whether or not
      // any particular tier/affinity combination ever fires.
      pool = categoryBases;
    }
  } else {
    // No category weighting — original behavior: partition all eligible bases
    // by affinity and roll aligned vs non-aligned.
    const { aligned, nonAligned } = _partitionBases(rarityEligibleBases, playerAffinity);
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
    const aligns = _rollAffinityAlignment(
      substreamRng(runKey, achievementId, rarity, 'alignment'),
      rarity,
    );
    pool = aligns ? aligned : nonAligned;
  }

  const itemLevel = Math.max(1, Math.floor(world.playerLevel.level));

  const transaction = createGeneratedEquipmentRegistryTransaction(world);
  const baseRng = substreamRng(runKey, achievementId, rarity, 'base');
  const baseId = pool[baseRng.nextInt(0, pool.length - 1)]!;
  const effectsRng = substreamRng(runKey, achievementId, rarity, 'effects');
  const instance = generateEquipmentInstance(
    { generatedEquipmentRegistry: transaction.registry, rng: effectsRng },
    { baseId, itemLevel, rarity },
    { rng: effectsRng, allowedEffectKinds: ['stat'] },
  );

  // Defense in depth: under the decoupled model a Common instance always has
  // zero non-armor stats (no base spreading, no effects), so this is a
  // no-op — but if a future change introduces a new affix path or bug, the
  // tripwire catches it loudly before it ships.
  _assertGeneratedRewardInstanceLegal(instance, rarity);

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
_validateFloor2RewardPoolTierEligibility();
