/**
 * Game-layer wrapper that spawns a Floor 2 boss chest for a defeated boss
 * family: resolves its equipment reward bundle (ADR 0069's
 * `resolveEquipmentRewardBundle`, reused verbatim) and registers the chest's
 * lifecycle record (`createBossChestRecord`, core layer). See ADR 0070 for
 * the full design.
 *
 * This module owns ONLY the boss-defeat → chest-creation boundary. Opening
 * and acknowledging a chest are pure core-layer state transitions
 * (`src/core/systems/bossChestRewards.ts`) and do not need game-layer
 * concerns, so they are re-exported here unchanged for callers that only
 * import from the game layer.
 */
import type { GameWorld } from '../core/world.js';
import {
  createBossChestId,
  createBossChestRecord,
  type BossChestRecord,
} from '../core/systems/bossChestRewards.js';
import { getFloor2EquipmentEconomyAccess } from '../core/floor2-equipment-flags.js';
import { resolveEquipmentRewardBundle } from './floor2-reward-bundle-resolver.js';
import type { EquipmentRewardTier } from '../shared/generated-equipment-types.js';
import { FLOOR2_WEAPON_WAVE_A_BASE_IDS } from '../shared/data/floor2-weapon-bases.js';

/**
 * Candidate base pool for boss chest reward bundles. Reuses the Floor 2
 * "wave A" weapon bases — the same stat-bonus-free generation base catalog
 * `floor2-field-kit` draws from — rather than
 * `FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS` (the Quartermaster's *sellable
 * item* catalog). Quartermaster items carry their own inherent non-armor
 * stat bonuses (crit, dodge, move speed, ...) and fail
 * `resolveEquipmentRewardBundle`'s Common-rarity contract ("no non-armor
 * stat bonus") for all but one entry — verified empirically while writing
 * this module's tests. `FLOOR2_WEAPON_WAVE_A_BASE_IDS` is validated at
 * module load (`validateWaveABases`) to have zero inherent stat bonuses on
 * every base, so it satisfies the contract by construction and contains
 * both physical- and magic-affinity weapons (23 physical, 2 magic), keeping
 * both the aligned and non-aligned pools non-empty for either player
 * affinity.
 */
export const BOSS_CHEST_REWARD_BASE_IDS: readonly string[] = FLOOR2_WEAPON_WAVE_A_BASE_IDS;

/**
 * Boss chests resolve at `tier4` — an 85% Uncommon / 15% Rare draw per
 * PLAN.md §E3-C. This replaces the original `tier1` (100% Common) intent and
 * correctly implements the Floor 2 equipment-economy spec. `validateGeneratedCarryover`
 * (`playerCarryover.ts`) hardcodes this same expectation when restoring a
 * persisted boss-chest bundle, since boss chests have no backing achievement
 * to cross-check a tier against.
 */
const BOSS_CHEST_REWARD_TIER: EquipmentRewardTier = 'tier4';

export type SpawnBossChestResult =
  | { readonly created: true; readonly chest: BossChestRecord }
  | { readonly created: false; readonly reason: 'notFloor2' | 'economyDisabled' | 'alreadyExists' };

/**
 * Spawn (or idempotently no-op on) the boss chest for `familyId`'s defeat.
 *
 * Fail-closed / Floor 1 exclusion: refuses to create a chest off Floor 2 or
 * with the Floor 2 equipment economy disabled — this is the same
 * `getFloor2EquipmentEconomyAccess` gate the Quartermaster uses (its doc
 * explicitly calls out boss chests as its second consumer), so Floor 1 stays
 * equipment-free regardless of flag values.
 *
 * Resolve-before-mutate: the reward bundle is resolved BEFORE the chest
 * record is created, mirroring `unlockAchievement`. A thrown
 * `RewardBundleResolutionError` (catalog/config integrity bug) propagates
 * rather than being swallowed, matching the achievement-unlock convention.
 *
 * Idempotent: calling this again for an already-chested family is a no-op
 * (`created: false, reason: 'alreadyExists'`) — the boss-defeat call site
 * (`floor2Scenario.ts`) already guards on a per-family "defeated once" set,
 * but this function is defensively idempotent on its own regardless.
 */
export function spawnBossChestForDefeatedBoss(
  world: GameWorld,
  familyId: string,
): SpawnBossChestResult {
  if (world.floor !== 2) {
    return { created: false, reason: 'notFloor2' };
  }
  const chestId = createBossChestId(familyId);
  if (world.bossChests.has(chestId)) {
    return { created: false, reason: 'alreadyExists' };
  }
  const access = getFloor2EquipmentEconomyAccess(world);
  if (access.kind === 'invalid') {
    throw new Error(access.message);
  }
  if (access.kind !== 'enabled') {
    return { created: false, reason: 'economyDisabled' };
  }

  resolveEquipmentRewardBundle(world, chestId, BOSS_CHEST_REWARD_BASE_IDS, BOSS_CHEST_REWARD_TIER);
  const result = createBossChestRecord(world, chestId, familyId);
  if (!result.ok) {
    // Unreachable in practice: the bundle was just resolved above, so
    // `createBossChestRecord`'s fail-closed "no bundle" guard cannot trip.
    // Thrown rather than silently swallowed, matching the fail-closed
    // convention used throughout this resolver.
    throw new Error(
      `Boss chest ${chestId} record creation failed unexpectedly after bundle resolution`,
    );
  }
  return { created: true, chest: result.chest };
}

export {
  createBossChestId,
  openBossChest,
  acknowledgeBossChestReveal,
  type BossChestState,
  type BossChestRecord,
  type OpenBossChestResult,
  type AcknowledgeBossChestResult,
} from '../core/systems/bossChestRewards.js';
