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
import { query } from 'bitecs';
import type { GameWorld } from '../core/world.js';
import { Player, Position } from '../core/components.js';
import {
  createBossChestId,
  createBossChestRecord,
  type BossChestRecord,
} from '../core/systems/bossChestRewards.js';
import { getEquipmentEconomyAccess } from '../core/floor2-equipment-flags.js';
import { getWorldFloorBehavior } from '../core/floor-behavior.js';
import { resolveEquipmentRewardBundle } from './floor2-reward-bundle-resolver.js';
import type { EquipmentRewardTier } from '../shared/generated-equipment-types.js';
import { FLOOR2_WEAPON_WAVE_A_BASE_IDS } from '../shared/data/floor2-weapon-bases.js';
import { spawnBossChestEntity } from '../core/spawners/world-objects.js';

/**
 * Candidate base pool for boss chest reward bundles. Reuses the Floor 2
 * "wave A" weapon bases — the same deterministic catalog
 * `floor2-field-kit` draws from — rather than the Quartermaster's sellable
 * wearable-gear catalog. The weapon pool is already balanced for both physical
 * and magic affinities (23 physical, 2 magic), keeping aligned and non-aligned
 * partitions non-empty for either player affinity.
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
  | {
      readonly created: false;
      readonly reason: 'bossChestsDisabled' | 'economyDisabled' | 'alreadyExists';
    };

function resolveBossChestSpawnPosition(
  world: GameWorld,
  x?: number,
  y?: number,
): { readonly x: number; readonly y: number } | null {
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  const playerEid = query(world.ecs, [Player, Position])[0];
  if (playerEid === undefined) {
    return null;
  }
  return {
    x: world.stores.position.x[playerEid] ?? 0,
    y: world.stores.position.y[playerEid] ?? 0,
  };
}

/**
 * Spawn (or idempotently no-op on) the boss chest for `familyId`'s defeat.
 * When `x` and `y` are provided, a physical ECS entity is spawned at that
 * position so the player can walk up to open it. When omitted (legacy /
 * secondary victory-sweep path where boss position is unknown) the chest
 * falls back to the live player position so it always remains reachable.
 */
export function spawnBossChestForDefeatedBoss(
  world: GameWorld,
  familyId: string,
  x?: number,
  y?: number,
): SpawnBossChestResult {
  if (!getWorldFloorBehavior(world).bossChests) {
    return { created: false, reason: 'bossChestsDisabled' };
  }
  const chestId = createBossChestId(familyId);
  if (world.bossChests.has(chestId)) {
    return { created: false, reason: 'alreadyExists' };
  }
  const access = getEquipmentEconomyAccess(world);
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
  const spawn = resolveBossChestSpawnPosition(world, x, y);
  if (spawn) {
    spawnBossChestEntity(world, spawn.x, spawn.y, chestId);
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
