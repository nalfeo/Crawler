/**
 * Resolves Floor 1 `lootBox` achievement rewards into immutable, persisted
 * bundles. Mirrors `resolveEquipmentRewardBundle`'s (Floor 2) resolve-once,
 * persist, never-re-derive pattern so BOTH reward paths honor the same hard
 * gate: generation happens ONLY at unlock (resolution) — never at claim,
 * load, or presentation.
 */
import {
  LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION,
  LOOT_BOX_GOLD_BY_TIER,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
  FLOOR1_COMMON_CRAFTING_MATERIALS,
  type LootBoxTier,
  type LootBoxRewardBundleV1,
} from '../shared/achievements.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import type { GameWorld } from '../core/world.js';

/**
 * Resolver version. Included in the derived RNG substream key so a future
 * change to the loot-box grant algorithm produces a distinct, non-colliding
 * stream even for the same run key + achievement.
 */
export const LOOT_BOX_RESOLVER_VERSION = 'v1';

export class LootBoxRewardResolutionError extends Error {
  constructor(
    readonly code: 'no-run-key' | 'empty-material-pool',
    message: string,
  ) {
    super(message);
    this.name = 'LootBoxRewardResolutionError';
  }
}

/**
 * Bundle-specific RNG substream derived from the run's stable `runKey` (NOT
 * `world.seed` directly, and NEVER `world.rng`) — matches Floor 2's
 * `substreamRng` derivation so both reward paths draw from the same class of
 * isolated, replay-safe stream and neither ever touches the gameplay RNG.
 */
function materialsRng(runKey: string, achievementId: string): SeededRandom {
  return new SeededRandom(
    hashStringToSeed(
      `lootbox-grant:${LOOT_BOX_RESOLVER_VERSION}:${runKey}:${achievementId}:materials`,
    ),
  );
}

/**
 * Resolve an achievement's Floor 1 `lootBox` reward into an immutable bundle
 * (gold + common crafting materials) and store it in
 * `world.lootBoxRewardBundles` keyed by `achievementId`. Gold and material
 * count scale with `tier` (see {@link LOOT_BOX_GOLD_BY_TIER} /
 * {@link LOOT_BOX_MATERIAL_COUNT_BY_TIER}); materials are drawn ONLY from
 * {@link FLOOR1_COMMON_CRAFTING_MATERIALS} — structurally never equipment,
 * never above Common rarity.
 *
 * Determinism & isolation:
 * - The material roll uses a bundle-specific {@link SeededRandom} derived
 *   from the run key + achievement id (no `world.rng` consumption → zero
 *   contamination of the gameplay stream). Replaying the same run key +
 *   achievement yields identical materials.
 *
 * Atomicity & fail-closed:
 * - {@link FLOOR1_COMMON_CRAFTING_MATERIALS} is derived directly from the
 *   item catalog, so every candidate material id is guaranteed catalog-valid;
 *   a later claim-time `addItem` can therefore never throw for an unknown
 *   item, making the resolved bundle claimable atomically with no rollback
 *   path required. The pool is still re-checked for emptiness here so a
 *   future catalog edit that empties it fails resolution instead of looping
 *   or throwing deeper inside `SeededRandom.pick`.
 * - Idempotent: if a bundle already exists for `achievementId` it is
 *   returned unchanged (never re-rolled).
 */
export function resolveLootBoxRewardBundle(
  world: GameWorld,
  achievementId: string,
  tier: LootBoxTier,
): LootBoxRewardBundleV1 {
  const existing = world.lootBoxRewardBundles.get(achievementId);
  if (existing !== undefined) return existing;

  const runKey = world.generatedEquipmentRegistry.runKey;
  if (runKey === null) {
    throw new LootBoxRewardResolutionError(
      'no-run-key',
      `Cannot resolve loot box bundle for ${achievementId}: registry has no run key`,
    );
  }

  if (FLOOR1_COMMON_CRAFTING_MATERIALS.length === 0) {
    throw new LootBoxRewardResolutionError(
      'empty-material-pool',
      `Cannot resolve loot box bundle for ${achievementId}: no common crafting materials in catalog`,
    );
  }

  const gold = LOOT_BOX_GOLD_BY_TIER[tier];
  const materialCount = LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier];
  const rng = materialsRng(runKey, achievementId);
  const materials: string[] = [];
  for (let i = 0; i < materialCount; i += 1) {
    materials.push(rng.pick(FLOOR1_COMMON_CRAFTING_MATERIALS));
  }

  const bundle: LootBoxRewardBundleV1 = Object.freeze({
    schemaVersion: LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION,
    achievementId,
    tier,
    gold,
    materials: Object.freeze(materials),
  });
  world.lootBoxRewardBundles.set(achievementId, bundle);
  return bundle;
}
