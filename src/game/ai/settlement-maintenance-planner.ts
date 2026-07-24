/**
 * Deterministic AI settlement-maintenance planner.
 *
 * Runs once per continuous settlement/safe-room visit and, exclusively via
 * existing legitimate/atomic APIs:
 *   1. Claims any unlocked-but-unclaimed achievement rewards.
 *   2. Opens/acknowledges any available/revealed boss chests.
 *   3. Runs a bounded greedy equipment-swap loop against
 *      `evaluateEquipmentLoadoutCandidates`, purchasing from the Quartermaster
 *      only through `purchaseQuartermasterOffer` when a shop candidate wins.
 *   4. Fills any still-open active-ability slots with already-owned abilities.
 *
 * This module NEVER mutates gameplay state directly (gold, inventory,
 * equipment, ability grants, achievement/chest records) — every state change
 * flows through an existing shared API that already enforces atomicity,
 * exact-once claiming, and fail-closed validation. This slice performs
 * actions only while the player is physically inside the settlement; it does
 * NOT implement travel-return routing to reach the settlement (a later,
 * dependent slice).
 *
 * Every decision (and every skip) is recorded in the returned
 * `SettlementMaintenanceResult.decisions` telemetry log so a replay can be
 * inspected and asserted on deterministically.
 */
import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import type { Floor2SettlementSnapshot } from '../../shared/floor-types.js';
import {
  isAchievementClaimed,
  claimAchievementReward,
} from '../../core/systems/achievementRewards.js';
import { openBossChest, acknowledgeBossChestReveal } from '../../core/systems/bossChestRewards.js';
import {
  getQuartermasterOfferViews,
  purchaseQuartermasterOffer,
} from '../../core/quartermaster-purchase.js';
import { equipFromBag, getEquipmentState } from '../../core/systems/equipmentSystem.js';
import { getGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import { getEntityEncumbranceSnapshot } from '../../core/encumbrance.js';
import { ACTIVE_ABILITY_SLOT_LIMIT, type AbilityGrantSourceId } from '../../shared/abilities.js';
import { configureOwnedActiveAbility, getOrCreateAbilityState } from '../systems/abilitySystem.js';
import { WeaponType } from '../../shared/constants.js';
import {
  ALL_STAT_IDS,
  PRIMARY_STATS,
  type PrimaryStatId,
  type StatId,
} from '../../shared/stats.js';
import type { GeneratedEquipmentInventoryEntry } from '../../shared/inventory.js';
import type { GeneratedEquipmentInstanceV1 } from '../../shared/generated-equipment-types.js';
import type { EquipFailureReason } from '../../shared/equipment-types.js';
import {
  evaluateEquipmentLoadoutCandidates,
  type EquipmentEncounterFixture,
  type EquipmentLoadoutCandidate,
  type EquipmentLoadoutSnapshot,
} from './equipment-loadout-evaluator.js';

/**
 * Bounds the number of equipment candidates the greedy loop accepts per visit
 * so it can never run unboundedly. Each accepted candidate consumes exactly
 * one loop iteration but may require up to two atomic API calls (a
 * `purchaseQuartermasterOffer` for shop candidates, always followed by one
 * `equipFromBag`) — so total equipment-loop mutations are bounded by
 * `2 * EQUIPMENT_LOOP_CANDIDATE_CAP`, still a small fixed constant.
 */
const EQUIPMENT_LOOP_CANDIDATE_CAP = 8;

/**
 * One fixed, canonical "average Floor 2 encounter" fixture. Settlement
 * maintenance is a non-combat opportunity, so the planner has no real
 * upcoming-encounter telemetry to draw from; using one constant, documented
 * fixture (rather than reading live combat state) keeps loadout scoring
 * deterministic and replay-stable regardless of when maintenance runs.
 */
const CANONICAL_ENCOUNTER_FIXTURE: EquipmentEncounterFixture = Object.freeze({
  id: 'settlement-maintenance-canonical-encounter',
  durationSeconds: 60,
  enemyCount: 6,
  clusteredEnemyCount: 3,
  incomingHitDamage: 10,
  incomingHitsPerSecond: 1,
  lowHealthUptime: 0.1,
  skillTriggerRatePerSecond: 1,
});

export type SettlementMaintenanceDecisionKind =
  | 'claim-achievement'
  | 'open-boss-chest'
  | 'acknowledge-boss-chest'
  | 'purchase-equipment'
  | 'equip-instance'
  | 'configure-ability'
  | 'skip';

export interface SettlementMaintenanceDecision {
  readonly kind: SettlementMaintenanceDecisionKind;
  readonly detail: string;
  /** Present for scored equipment decisions — the evaluator's swap score. */
  readonly utility?: number;
  /** Present for purchase decisions — gold spent. */
  readonly cost?: number;
}

export type SettlementMaintenanceTerminationReason =
  | 'no-opportunity'
  | 'already-processed'
  | 'action-cap-equipment'
  | 'exhausted';

export interface SettlementMaintenanceResult {
  /** True only when the planner actually ran its decision loops this call. */
  readonly ran: boolean;
  readonly terminationReason: SettlementMaintenanceTerminationReason;
  readonly decisions: readonly SettlementMaintenanceDecision[];
}

interface SettlementVisitLatch {
  wasInSettlement: boolean;
  processed: boolean;
}

/**
 * Per-world "have we already run maintenance for this continuous settlement
 * visit" latch. Keyed by `GameWorld` reference so each world/run tracks its
 * own visit state and stale entries are garbage-collected with the world.
 */
const settlementVisitLatches = new WeakMap<GameWorld, SettlementVisitLatch>();

function isPlayerInSettlementRoom(
  world: GameWorld,
  playerEid: number,
  settlement: Floor2SettlementSnapshot,
  floorMap: FloorMap,
): boolean {
  const x = world.stores.position.x[playerEid] ?? 0;
  const y = world.stores.position.y[playerEid] ?? 0;
  const tile = floorMap.worldToTile(x, y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  return roomId !== -1 && settlement.settlementRoomIds.includes(roomId);
}

/**
 * Attempts a single achievement claim. On the first pass (`isRetry: false`),
 * a `grantFailed` failure (e.g. bag full) is deferred — no decision is
 * recorded yet, and the caller collects it for a single bounded retry after
 * the equipment loop has had a chance to free bag capacity (equipping moves
 * generated-equipment instances OUT of the bag). On a retry attempt (or any
 * non-`grantFailed` reason), the outcome is always recorded immediately,
 * since there is no further retry opportunity this visit.
 */
function attemptAchievementClaim(
  world: GameWorld,
  achievementId: string,
  decisions: SettlementMaintenanceDecision[],
  isRetry: boolean,
): { readonly deferred: boolean } {
  const result = claimAchievementReward(world, achievementId);
  if (result.ok) {
    decisions.push({
      kind: 'claim-achievement',
      detail: isRetry
        ? `Claimed achievement reward for '${achievementId}' (retried after equipment loop freed bag capacity)`
        : `Claimed achievement reward for '${achievementId}'`,
    });
    return { deferred: false };
  }
  if (!isRetry && result.reason === 'grantFailed') {
    return { deferred: true };
  }
  decisions.push({
    kind: 'skip',
    detail: `Could not claim achievement '${achievementId}': ${result.reason}`,
  });
  return { deferred: false };
}

function planAchievementClaims(
  world: GameWorld,
  decisions: SettlementMaintenanceDecision[],
): readonly string[] {
  const achievementIds = [...world.achievements.unlockedIds].sort();
  const deferred: string[] = [];
  for (const achievementId of achievementIds) {
    if (isAchievementClaimed(world, achievementId)) continue;
    if (attemptAchievementClaim(world, achievementId, decisions, false).deferred) {
      deferred.push(achievementId);
    }
  }
  return deferred;
}

/**
 * Bounded, deterministic single retry pass for achievement claims that
 * deferred on `grantFailed` during the initial pass. Called once, after the
 * equipment loop settles, so a bag-full failure at claim time can still
 * succeed later in the same visit if equipping freed capacity.
 */
function retryDeferredAchievementClaims(
  world: GameWorld,
  decisions: SettlementMaintenanceDecision[],
  deferredAchievementIds: readonly string[],
): void {
  for (const achievementId of deferredAchievementIds) {
    attemptAchievementClaim(world, achievementId, decisions, true);
  }
}

/**
 * Attempts to open (and, once revealed, acknowledge) a single boss chest.
 * Mirrors {@link attemptAchievementClaim}'s defer-then-retry-once contract:
 * an open failing with `grantFailed` on the first pass is deferred rather
 * than recorded, so the caller can retry once after the equipment loop frees
 * bag capacity. `acknowledgeBossChestReveal` never touches inventory (the
 * reward was already granted at open time), so it never needs deferring.
 */
function attemptBossChestOpen(
  world: GameWorld,
  playerEid: number,
  chestId: string,
  decisions: SettlementMaintenanceDecision[],
  isRetry: boolean,
): { readonly deferred: boolean } {
  const chest = world.bossChests.get(chestId);
  if (!chest || chest.state === 'claimed') return { deferred: false };

  if (chest.state === 'available') {
    const openResult = openBossChest(world, chestId, playerEid);
    if (!openResult.ok) {
      if (!isRetry && openResult.reason === 'grantFailed') {
        return { deferred: true };
      }
      decisions.push({
        kind: 'skip',
        detail: `Could not open boss chest '${chestId}': ${openResult.reason}`,
      });
      return { deferred: false };
    }
    if (!openResult.alreadyClaimed) {
      decisions.push({
        kind: 'open-boss-chest',
        detail: isRetry
          ? `Opened boss chest '${chestId}' (retried after equipment loop freed bag capacity)`
          : `Opened boss chest '${chestId}' (family reward revealed)`,
      });
    }
  }

  // `chest` is the same object stored in `world.bossChests` — `openBossChest`
  // mutates `chest.state` in place, so re-reading it here observes the
  // post-open state without a second map lookup.
  if (chest.state === 'revealed') {
    const ackResult = acknowledgeBossChestReveal(world, chestId);
    if (ackResult.ok) {
      if (!ackResult.alreadyClaimed) {
        decisions.push({
          kind: 'acknowledge-boss-chest',
          detail: `Acknowledged boss chest '${chestId}' reveal`,
        });
      }
    } else {
      decisions.push({
        kind: 'skip',
        detail: `Could not acknowledge boss chest '${chestId}': ${ackResult.reason}`,
      });
    }
  }
  return { deferred: false };
}

function planBossChestActions(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
): readonly string[] {
  const chestIds = [...world.bossChests.keys()].sort();
  const deferred: string[] = [];
  for (const chestId of chestIds) {
    if (attemptBossChestOpen(world, playerEid, chestId, decisions, false).deferred) {
      deferred.push(chestId);
    }
  }
  return deferred;
}

/**
 * Bounded, deterministic single retry pass for boss-chest opens that deferred
 * on `grantFailed` during the initial pass. See
 * {@link retryDeferredAchievementClaims} for the same rationale.
 */
function retryDeferredBossChestActions(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
  deferredChestIds: readonly string[],
): void {
  for (const chestId of deferredChestIds) {
    attemptBossChestOpen(world, playerEid, chestId, decisions, true);
  }
}

function toSourceArrayMap(
  source: ReadonlyMap<string, ReadonlySet<AbilityGrantSourceId>>,
): Map<string, readonly AbilityGrantSourceId[]> {
  const result = new Map<string, readonly AbilityGrantSourceId[]>();
  for (const [abilityId, sources] of source) {
    result.set(abilityId, [...sources].sort());
  }
  return result;
}

function buildEquipmentSnapshot(world: GameWorld, playerEid: number): EquipmentLoadoutSnapshot {
  const equipmentState = getEquipmentState(world, playerEid);
  // A two-handed item occupies more than one slot key with the SAME
  // instanceId (e.g. mainHand + offHand); the evaluator expects `equipped` to
  // be a de-duplicated instance list (one entry per physically-equipped
  // item), not one entry per occupied slot, so collect by instanceId first.
  const seenInstanceIds = new Set<string>();
  const equipped: GeneratedEquipmentInstanceV1[] = [];
  for (const instanceId of Object.values(equipmentState?.equipped ?? {})) {
    if (typeof instanceId !== 'string' || seenInstanceIds.has(instanceId)) continue;
    seenInstanceIds.add(instanceId);
    const instance = getGeneratedEquipmentInstance(world, instanceId);
    if (instance) equipped.push(instance);
  }

  const baseStats = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    baseStats[statId] = world.stores.baseStats[statId][playerEid] ?? 0;
  }
  const coreStatPoints = {} as Record<PrimaryStatId, number>;
  for (const primaryStatId of PRIMARY_STATS) {
    coreStatPoints[primaryStatId] = world.stores.coreStatPoints[primaryStatId][playerEid] ?? 0;
  }

  const abilityState = getOrCreateAbilityState(world, playerEid);

  return {
    equipped,
    baseStats,
    coreStatPoints,
    activeAbilityGrantSources: toSourceArrayMap(
      abilityState.grantOwnership.activeSourcesByAbilityId,
    ),
    passiveAbilityGrantSources: toSourceArrayMap(
      abilityState.grantOwnership.passiveSourcesByAbilityId,
    ),
    equippedActiveAbilityIds: [...abilityState.equippedActiveAbilityIds],
    bodyWeightLb: getEntityEncumbranceSnapshot(world, playerEid).bodyWeightLb,
  };
}

/**
 * Simple, intentionally non-exhaustive affinity heuristic: weight the
 * player's current weapon-type tag (magic vs. physical, matching the
 * evaluator's own `affinityValue` classification) and reward any
 * ability-granting candidate, so the greedy loop mildly prefers loadouts
 * that stay consistent with the current build rather than thrashing between
 * unrelated playstyles.
 */
function deriveAffinityTagWeights(
  equipped: readonly GeneratedEquipmentInstanceV1[],
): Record<string, number> {
  const weights: Record<string, number> = {
    'active-ability': 1,
    'passive-ability': 1,
  };
  const weaponInstance = equipped.find((instance) => instance.frozen.activeWeaponSnapshot !== null);
  const weapon = weaponInstance?.frozen.activeWeaponSnapshot ?? null;
  if (weapon) {
    weights[weapon.weaponType === WeaponType.MAGIC ? 'magic' : 'physical'] = 3;
  }
  return weights;
}

function describeEquipFailureReason(reason: EquipFailureReason): string {
  switch (reason.type) {
    case 'unknownSlot':
      return `unknown slot '${reason.slotId}'`;
    case 'occupiedSlot':
      return `occupied slot '${reason.slotId}'`;
    default:
      return reason.message;
  }
}

interface ShopOfferRef {
  readonly stockId: string;
  readonly offerId: string;
}

interface EquipmentCandidateSet {
  readonly candidates: EquipmentLoadoutCandidate[];
  readonly offerLookup: ReadonlyMap<string, ShopOfferRef>;
}

function buildEquipmentCandidates(world: GameWorld, playerEid: number): EquipmentCandidateSet {
  const candidates: EquipmentLoadoutCandidate[] = [];
  const offerLookup = new Map<string, ShopOfferRef>();

  const bag = world.inventories.get(playerEid);
  for (const entry of bag?.generatedEquipment ?? []) {
    const instance = getGeneratedEquipmentInstance(world, entry.instanceKey);
    if (instance) {
      candidates.push({ instance, source: 'inventory', purchaseCost: 0 });
    }
  }

  for (const offer of getQuartermasterOfferViews(world, playerEid)) {
    if (!offer.canPurchase) continue;
    const instance = getGeneratedEquipmentInstance(world, offer.instanceId);
    if (!instance) continue;
    candidates.push({ instance, source: 'shop', purchaseCost: offer.unitPrice });
    offerLookup.set(instance.instanceId, { stockId: offer.stockId, offerId: offer.offerId });
  }

  return { candidates, offerLookup };
}

/**
 * Apply the evaluator-chosen ability configuration for the just-accepted
 * candidate. Only *adds* newly-available abilities the evaluator selected;
 * abilities that lost their grant source when the displaced item was
 * unequipped are already pruned from `equippedActiveAbilityIds` by the
 * ability system itself (see `syncDerivedAbilityLists`), so no explicit
 * unequip step is needed here.
 */
function applyConfiguredAbilities(
  world: GameWorld,
  playerEid: number,
  configuredActiveAbilityIds: readonly string[],
  decisions: SettlementMaintenanceDecision[],
): void {
  for (const abilityId of configuredActiveAbilityIds) {
    const abilityState = getOrCreateAbilityState(world, playerEid);
    if (abilityState.equippedActiveAbilityIds.includes(abilityId)) continue;
    if (abilityState.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) continue;
    try {
      configureOwnedActiveAbility(world, playerEid, abilityId);
      decisions.push({
        kind: 'configure-ability',
        detail: `Configured ability '${abilityId}' selected by the equipment swap`,
      });
    } catch (error) {
      decisions.push({
        kind: 'skip',
        detail: `Could not configure ability '${abilityId}' from equipment swap: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
}

/**
 * Bounded greedy single-swap hill-climb: each iteration re-evaluates every
 * candidate against the CURRENT loadout, executes the single best positive
 * swap (purchase-then-equip for shop candidates), applies the evaluator's
 * chosen ability configuration, then rebuilds the snapshot and repeats. This
 * does NOT guarantee a globally-optimal loadout (a full search is not
 * bounded/deterministic-cheap enough for a per-tick AI system) — it is a
 * documented, intentionally-bounded approximation.
 *
 * A candidate that fails to purchase or equip (stale offer, insufficient
 * funds, occupied/unknown slot, etc.) is added to a this-visit blacklist and
 * excluded from re-evaluation, then the loop CONTINUES to the next-best
 * candidate rather than aborting the whole visit — a single failing item
 * should not block equipping every other positive-utility candidate still
 * available. The blacklist is scoped to this call only (not persisted across
 * visits), and the loop remains bounded by `EQUIPMENT_LOOP_CANDIDATE_CAP`
 * regardless of how many candidates fail.
 */
function runEquipmentLoop(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
): SettlementMaintenanceTerminationReason {
  const blacklistedInstanceIds = new Set<string>();
  for (let step = 0; step < EQUIPMENT_LOOP_CANDIDATE_CAP; step += 1) {
    const snapshot = buildEquipmentSnapshot(world, playerEid);
    const { candidates: allCandidates, offerLookup } = buildEquipmentCandidates(world, playerEid);
    const candidates = allCandidates.filter(
      (candidate) => !blacklistedInstanceIds.has(candidate.instance.instanceId),
    );
    if (candidates.length === 0) {
      return 'exhausted';
    }

    const evaluation = evaluateEquipmentLoadoutCandidates({
      current: snapshot,
      candidates,
      remainingEncounters: [CANONICAL_ENCOUNTER_FIXTURE],
      affinityTagWeights: deriveAffinityTagWeights(snapshot.equipped),
    });

    const top = evaluation.ranked[0];
    if (!top || top.score <= 0) {
      return 'exhausted';
    }

    const instance = top.candidate.instance;

    if (top.candidate.source === 'shop') {
      const offerRef = offerLookup.get(instance.instanceId);
      if (!offerRef) {
        decisions.push({
          kind: 'skip',
          detail: `Top-ranked shop candidate '${instance.instanceId}' has no matching offer (stale); blacklisting and continuing`,
        });
        blacklistedInstanceIds.add(instance.instanceId);
        continue;
      }
      const purchase = purchaseQuartermasterOffer(world, playerEid, {
        stockId: offerRef.stockId,
        offerId: offerRef.offerId,
        quantity: 1,
      });
      if (!purchase.ok) {
        decisions.push({
          kind: 'skip',
          detail: `Purchase failed for '${instance.instanceId}': ${purchase.reason}; blacklisting and continuing`,
        });
        blacklistedInstanceIds.add(instance.instanceId);
        continue;
      }
      decisions.push({
        kind: 'purchase-equipment',
        detail: `Purchased '${instance.instanceId}' for ${purchase.goldSpent}g`,
        cost: purchase.goldSpent,
      });
    }

    const bagEntry: GeneratedEquipmentInventoryEntry = {
      kind: 'generated-instance',
      instanceKey: instance.instanceId,
    };
    const equipResult = equipFromBag(world, playerEid, bagEntry);
    if (!equipResult.ok) {
      decisions.push({
        kind: 'skip',
        detail: `Equip failed for '${instance.instanceId}': ${equipResult.reasons
          .map(describeEquipFailureReason)
          .join('; ')}; blacklisting and continuing`,
      });
      blacklistedInstanceIds.add(instance.instanceId);
      continue;
    }
    decisions.push({
      kind: 'equip-instance',
      detail: `Equipped '${instance.instanceId}' (swap score ${top.score.toFixed(2)})`,
      utility: top.score,
    });

    applyConfiguredAbilities(world, playerEid, top.configuredActiveAbilityIds, decisions);
  }
  return 'action-cap-equipment';
}

/**
 * After the equipment loop settles, fill any still-open active-ability slots
 * with abilities the player already owns (grant source present) but hasn't
 * equipped — deterministic ascending-id order, bounded by both the finite
 * candidate list and `ACTIVE_ABILITY_SLOT_LIMIT`.
 */
function fillRemainingOwnedAbilities(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
): void {
  const abilityState = getOrCreateAbilityState(world, playerEid);
  const ownedButUnequipped = [...(abilityState.ownedActiveAbilityIds ?? [])]
    .filter((abilityId) => !abilityState.equippedActiveAbilityIds.includes(abilityId))
    .sort();

  for (const abilityId of ownedButUnequipped) {
    const current = getOrCreateAbilityState(world, playerEid);
    if (current.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) break;
    try {
      configureOwnedActiveAbility(world, playerEid, abilityId);
      decisions.push({
        kind: 'configure-ability',
        detail: `Filled open active-ability slot with already-owned ability '${abilityId}'`,
      });
    } catch (error) {
      decisions.push({
        kind: 'skip',
        detail: `Could not fill ability slot with '${abilityId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
}

/**
 * Deterministic AI settlement-maintenance planner entry point. No-ops
 * (returns `ran: false`) unless the player is currently inside the Floor 2
 * settlement's safe-room cluster, and runs its full decision loop exactly
 * once per continuous visit (re-entering the settlement after leaving resets
 * the latch, but calling this repeatedly while still inside is a safe no-op).
 *
 * Mirrors the no-op-gated call style of `autoFloor1ProgressionSystem` /
 * `autoFloor2ProgressionSystem` so it can be called unconditionally every
 * tick from the real pipeline.
 */
export function runSettlementMaintenancePlanner(world: GameWorld): SettlementMaintenanceResult {
  const settlement = world.floorExtendedState?.settlement;
  const floorMap = world.floorMap;
  const latch = settlementVisitLatches.get(world) ?? { wasInSettlement: false, processed: false };

  if (!settlement || !floorMap) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return { ran: false, terminationReason: 'no-opportunity', decisions: [] };
  }

  const playerEid = query(world.ecs, [Player])[0];
  if (playerEid === undefined) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return { ran: false, terminationReason: 'no-opportunity', decisions: [] };
  }

  const inSettlement = isPlayerInSettlementRoom(world, playerEid, settlement, floorMap);
  if (!inSettlement) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return { ran: false, terminationReason: 'no-opportunity', decisions: [] };
  }

  if (latch.processed) {
    latch.wasInSettlement = true;
    settlementVisitLatches.set(world, latch);
    return { ran: false, terminationReason: 'already-processed', decisions: [] };
  }

  latch.wasInSettlement = true;
  latch.processed = true;
  settlementVisitLatches.set(world, latch);

  const decisions: SettlementMaintenanceDecision[] = [];
  const deferredAchievementIds = planAchievementClaims(world, decisions);
  const deferredChestIds = planBossChestActions(world, playerEid, decisions);
  const terminationReason = runEquipmentLoop(world, playerEid, decisions);
  // Retry any reward claims that deferred on a bag-full `grantFailed` during
  // the first pass — the equipment loop above may have freed bag capacity by
  // equipping items out of the bag, so a claim that failed at the top of the
  // visit can still succeed once, later in the same visit.
  retryDeferredAchievementClaims(world, decisions, deferredAchievementIds);
  retryDeferredBossChestActions(world, playerEid, decisions, deferredChestIds);
  fillRemainingOwnedAbilities(world, playerEid, decisions);

  return { ran: true, terminationReason, decisions };
}
