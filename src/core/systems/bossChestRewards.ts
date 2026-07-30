/**
 * Boss chest lifecycle (reveal/claim-only).
 *
 * Lives in core so both the engine panel and game systems can drive the
 * lifecycle without crossing layer boundaries — mirrors
 * {@link ../../game/floor2-reward-bundle-resolver.ts | resolveEquipmentRewardBundle}
 * (game layer, resolves the bundle) / {@link achievementRewards.ts} (the
 * analogous achievement-claim primitive this module is patterned after).
 *
 * A boss chest never generates or resolves its own reward bundle — that is
 * the game layer's job (see `src/game/boss-chest-resolver.ts`), reusing
 * ADR 0069's `resolveEquipmentRewardBundle` keyed by `boss-chest:<familyId>`.
 * This module owns only the four-state lifecycle
 * (`available` → `opening` → `revealed` → `claimed`) and the exact-once
 * atomic claim, via {@link claimGeneratedEquipmentRewardBundle}. See
 * ADR 0070 for the full design rationale and alternatives considered.
 */
import type { GameWorld } from '../world.js';
import {
  claimGeneratedEquipmentRewardBundle,
  type ClaimedRewardBundleEntry,
} from './equipmentSystem.js';
import type { EquipFailureReason } from '../../shared/equipment-types.js';
import { BOSS_CHEST_ID_PREFIX } from '../../shared/achievements.js';
import type { ResolvedRewardPresentation } from '../../shared/reward-presentation.js';

export type BossChestState = 'available' | 'opening' | 'revealed' | 'claimed';

export interface BossChestRecord {
  readonly chestId: string;
  readonly familyId: string;
  state: BossChestState;
  readonly createdAtMs: number;
  /**
   * Snapshot of the exact reward granted on the real `available` -> `revealed`
   * transition, captured purely for redisplay (e.g. after a reload mid- or
   * post-presentation). Set once and never cleared/re-rolled — reading it is
   * always safe regardless of `state` (`revealed` or `claimed`). `undefined`
   * only for chests created before this field existed (legacy carryover) or
   * not yet opened.
   */
  revealedGrant?: ResolvedRewardPresentation;
}

/** Deterministic, collision-free chest id for a family's boss reward. */
export function createBossChestId(familyId: string): string {
  return `${BOSS_CHEST_ID_PREFIX}${familyId}`;
}

export type CreateBossChestRecordResult =
  | { readonly ok: true; readonly created: boolean; readonly chest: BossChestRecord }
  | { readonly ok: false; readonly reason: 'noBundle' };

/**
 * Register a boss chest's lifecycle record for an already-resolved reward
 * bundle. Fail-closed: refuses to create an `available` chest unless a live
 * bundle already exists at `chestId` in `world.generatedEquipmentRewardBundles`
 * (the caller — the game-layer resolver — must resolve the bundle first).
 * Idempotent: a second call for an already-registered chest returns the
 * existing record unchanged (`created: false`), never re-creating or
 * resetting its state.
 */
export function createBossChestRecord(
  world: GameWorld,
  chestId: string,
  familyId: string,
): CreateBossChestRecordResult {
  const existing = world.bossChests.get(chestId);
  if (existing) {
    return { ok: true, created: false, chest: existing };
  }
  if (!world.generatedEquipmentRewardBundles.has(chestId)) {
    return { ok: false, reason: 'noBundle' };
  }
  const chest: BossChestRecord = {
    chestId,
    familyId,
    state: 'available',
    createdAtMs: world.elapsedMs,
  };
  world.bossChests.set(chestId, chest);
  return { ok: true, created: true, chest };
}

export type OpenBossChestResult =
  | {
      readonly ok: true;
      readonly alreadyClaimed: boolean;
      readonly state: BossChestState;
      readonly granted?: readonly ClaimedRewardBundleEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknownChest' | 'invalidTransition' | 'grantFailed';
      readonly detail?: EquipFailureReason;
    };

/**
 * Open a boss chest for `entity`, transferring its resolved reward bundle's
 * instances into the entity's bag via the shared exact-once atomic claim path
 * ({@link claimGeneratedEquipmentRewardBundle}) — this function NEVER invokes
 * the generator; the bundle was resolved once at chest-creation time.
 *
 * Deterministic transitions:
 * - `available` → `opening` → `revealed` on a successful claim.
 * - `available` → `available` (reverted) on a failed claim (e.g. bag full),
 *   so the chest stays retryable and the reward is never lost.
 * - `revealed`/`claimed` → idempotent no-op success (`alreadyClaimed: true`):
 *   re-opening never re-touches RNG or the generator.
 * - `opening` (only reachable if a caller re-enters synchronously, which
 *   cannot happen in single-threaded JS within one call) and unknown chest
 *   ids fail closed with `invalidTransition` / `unknownChest`.
 */
export function openBossChest(
  world: GameWorld,
  chestId: string,
  entity: number,
): OpenBossChestResult {
  const chest = world.bossChests.get(chestId);
  if (!chest) {
    return { ok: false, reason: 'unknownChest' };
  }
  if (chest.state === 'claimed' || chest.state === 'revealed') {
    return { ok: true, alreadyClaimed: true, state: chest.state };
  }
  if (chest.state === 'opening') {
    return { ok: false, reason: 'invalidTransition' };
  }

  chest.state = 'opening';
  // Boss chests resolve at `tier4` (see `src/game/boss-chest-resolver.ts`
  // `BOSS_CHEST_REWARD_TIER`) — 85% Uncommon / 15% Rare per PLAN.md §E3-C.
  // Pass it explicitly here so the claim path's tier cross-check (defense in
  // depth against a tampered/stale bundle) has something to validate against,
  // mirroring the achievement-claim call site.
  const grant = claimGeneratedEquipmentRewardBundle(world, entity, chestId, 'tier4');
  if (!grant.ok) {
    // Fail-closed but retryable: revert to `available` so a transient failure
    // (e.g. bag full) never strands the chest or the reward.
    chest.state = 'available';
    return { ok: false, reason: 'grantFailed', detail: grant.reason };
  }
  chest.state = 'revealed';
  chest.revealedGrant = {
    kind: 'equipment',
    tier: 'tier4',
    instanceKeys: grant.granted.map((entry) => entry.instanceKey),
  };
  return { ok: true, alreadyClaimed: false, state: 'revealed', granted: grant.granted };
}

export type AcknowledgeBossChestResult =
  | { readonly ok: true; readonly alreadyClaimed: boolean }
  | { readonly ok: false; readonly reason: 'unknownChest' | 'invalidTransition' };

/**
 * Acknowledge a revealed chest's reveal, transitioning `revealed` → `claimed`
 * (terminal). This is a state-transition primitive only — no
 * presentation/audio is implemented here; a future UX layer calls this once
 * its reveal animation/UI has been dismissed. Idempotent: a chest already
 * `claimed` returns success with `alreadyClaimed: true`. Fail-closed:
 * acknowledging an `available`/`opening` chest (reveal never happened) is
 * rejected as an invalid transition.
 */
export function acknowledgeBossChestReveal(
  world: GameWorld,
  chestId: string,
): AcknowledgeBossChestResult {
  const chest = world.bossChests.get(chestId);
  if (!chest) {
    return { ok: false, reason: 'unknownChest' };
  }
  if (chest.state === 'claimed') {
    return { ok: true, alreadyClaimed: true };
  }
  if (chest.state !== 'revealed') {
    return { ok: false, reason: 'invalidTransition' };
  }
  chest.state = 'claimed';
  return { ok: true, alreadyClaimed: false };
}
