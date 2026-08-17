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
  acknowledgeAchievementRewardPresentation,
  isAchievementClaimed,
  claimAchievementReward,
} from '../../core/systems/achievementRewards.js';
import { openBossChest, acknowledgeBossChestReveal } from '../../core/systems/bossChestRewards.js';
import {
  getQuartermasterOfferViews,
  purchaseQuartermasterOffer,
} from '../../core/quartermaster-purchase.js';
import { equipFromBag, getEquipmentState } from '../../core/systems/equipmentSystem.js';
import { isInSafeContext } from '../../core/safe-space.js';
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
import {
  listGeneratedEquipmentReferences,
  type GeneratedEquipmentInventoryEntry,
} from '../../shared/inventory.js';
import type { GeneratedEquipmentInstanceV1 } from '../../shared/generated-equipment-types.js';
import type { EquipFailureReason, EquipmentInstance } from '../../shared/equipment-types.js';
import type { EquipmentSlotId } from '../../shared/equipment-slots.js';
import type {
  SettlementMaintenanceDecision,
  SettlementMaintenanceResult,
  SettlementMaintenanceTerminationReason,
} from './settlement-maintenance-types.js';
import {
  evaluateEquipmentLoadoutCandidates,
  type EquipmentEncounterFixture,
  type EquipmentLoadoutCandidate,
  type EquipmentLoadoutSnapshot,
  type StaticEquipmentBaselineV1,
} from './equipment-loadout-evaluator.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import type { WeaponClassSkillId } from '../../shared/weapon-skills.js';

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
  incomingHitDamage: 25,
  incomingHitsPerSecond: 1,
  lowHealthUptime: 0.1,
  skillTriggerRatePerSecond: 1,
});

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

/**
 * Per-world "last call's result" cache. Lets a caller (e.g. the settlement
 * return router in `settlement-return-router.ts`) observe whether the most
 * recent {@link runSettlementMaintenancePlanner} call actually processed a
 * visit — the return value itself was previously discarded by the only call
 * site (`headless-runner.ts`). Additive only: does not change the function's
 * return value or behavior, just mirrors it into a side-channel getter.
 */
const lastSettlementMaintenanceResults = new WeakMap<GameWorld, SettlementMaintenanceResult>();

/**
 * Returns the {@link SettlementMaintenanceResult} from the most recent
 * {@link runSettlementMaintenancePlanner} call for this world, or `null` if
 * the planner has never been called for it yet. One frame stale relative to
 * the current tick's planner call (visible starting the frame after it ran),
 * which is acceptable for callers that only need to know a visit has been
 * processed at some point during a continuous safe-room dwell.
 */
export function getLastSettlementMaintenanceResult(
  world: GameWorld,
): SettlementMaintenanceResult | null {
  return lastSettlementMaintenanceResults.get(world) ?? null;
}

function recordSettlementMaintenanceResult(
  world: GameWorld,
  result: SettlementMaintenanceResult,
): SettlementMaintenanceResult {
  lastSettlementMaintenanceResults.set(world, result);
  return result;
}

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
    acknowledgeAchievementRewardPresentation(world, achievementId);
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

function buildEquipmentSnapshot(
  world: GameWorld,
  playerEid: number,
  staticEquipped: readonly StaticEquipmentBaselineV1[],
): EquipmentLoadoutSnapshot {
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
    staticEquipped,
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
 * Classification of the STATIC (non-generated) items the player currently has
 * equipped — e.g. the Floor 1/2 starter weapon or `MERCHANTS_CHARM_DEF`, both
 * equipped via `equip(world, entity, staticDef, { force: true })`, which mints
 * a numeric `EquipmentInstanceId` rather than a generated-equipment string key.
 */
interface StaticEquippedClassification {
  /**
   * Static items whose scoring contribution the evaluator can model exactly,
   * fed to it as `EquipmentLoadoutSnapshot.staticEquipped`. Candidates MAY
   * displace these, because the swap is then scored honestly against them.
   */
  readonly baselines: readonly StaticEquipmentBaselineV1[];
  /**
   * Slots held by static items the evaluator canNOT model (status-effect
   * grants, unresolvable weapon defs, non-finite scoring data). These stay
   * PROTECTED: no bag/shop candidate may target them, so the greedy loop can
   * never displace an item it cannot see or score a replacement against.
   */
  readonly protectedSlots: ReadonlySet<EquipmentSlotId>;
  /**
   * Weapon-class skill of the modelable statically-equipped WEAPON occupying
   * each slot (e.g. `mainHand` -> `'ranged'` for the pistol starter). Used to
   * keep a mid-run weapon swap inside the archetype the run has been
   * levelling (see {@link displacesIncompatibleStaticWeaponClass}).
   */
  readonly staticWeaponClassBySlot: ReadonlyMap<EquipmentSlotId, WeaponClassSkillId>;
}

/**
 * Single fail-closed classifier shared by {@link buildEquipmentSnapshot} and
 * the candidate filter. Having ONE source of truth is what guarantees a
 * static item is either modelled by the evaluator or protected from
 * displacement — never omitted from scoring *and* displaceable.
 *
 * A static item is modelable only when every field the evaluator scores is
 * representable: finite weight/stat bonuses, at least one occupied slot, no
 * status-effect grants (the evaluator has no model for them), and — for
 * weapons — a `weaponId` that resolves to a canonical `WeaponDef`.
 */
function classifyStaticEquippedInstances(
  world: GameWorld,
  playerEid: number,
): StaticEquippedClassification {
  const equipmentState = getEquipmentState(world, playerEid);
  const protectedSlots = new Set<EquipmentSlotId>();
  const occupiedSlotsByInstanceId = new Map<number, EquipmentSlotId[]>();
  for (const [slotId, instanceId] of Object.entries(equipmentState?.equipped ?? {})) {
    if (typeof instanceId !== 'number') continue;
    const slots = occupiedSlotsByInstanceId.get(instanceId) ?? [];
    slots.push(slotId as EquipmentSlotId);
    occupiedSlotsByInstanceId.set(instanceId, slots);
  }

  const baselines: StaticEquipmentBaselineV1[] = [];
  const staticWeaponClassBySlot = new Map<EquipmentSlotId, WeaponClassSkillId>();
  for (const [instanceId, slots] of [...occupiedSlotsByInstanceId.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    const baseline = modelableStaticBaseline(equipmentState?.instances.get(instanceId), slots);
    if (baseline === null) {
      for (const slotId of slots) protectedSlots.add(slotId);
      continue;
    }
    baselines.push(baseline);
    const weaponDef = baseline.weaponId === null ? undefined : getWeaponDef(baseline.weaponId);
    if (weaponDef !== undefined) {
      for (const slotId of baseline.slots) {
        staticWeaponClassBySlot.set(slotId, weaponDef.weaponClassSkillId);
      }
    }
  }
  return { baselines, protectedSlots, staticWeaponClassBySlot };
}

/**
 * Returns the canonical evaluator baseline for a statically-equipped
 * instance, or `null` when any part of its contribution cannot be modelled
 * (fail-closed — the caller then protects its slots).
 */
function modelableStaticBaseline(
  instance: EquipmentInstance | undefined,
  occupiedSlots: readonly EquipmentSlotId[],
): StaticEquipmentBaselineV1 | null {
  if (instance === undefined || typeof instance.instanceId !== 'number') return null;
  const def = instance.def;
  if (occupiedSlots.length === 0) return null;
  if ((def.grantsStatusEffects?.length ?? 0) > 0) return null;
  if (!Number.isFinite(def.weightLb) || def.weightLb < 0) return null;
  for (const value of Object.values(def.statBonuses)) {
    if (!Number.isFinite(value)) return null;
  }
  const weaponId = def.weaponId ?? null;
  if (weaponId !== null && getWeaponDef(weaponId) === undefined) return null;
  return {
    equipmentInstanceId: instance.instanceId,
    slots: [...occupiedSlots].sort((a, b) => a.localeCompare(b)),
    tags: def.tags ?? [],
    weightLb: def.weightLb,
    statBonuses: def.statBonuses,
    weaponId,
  };
}

/**
 * True when equipping `instance` would displace a statically-equipped weapon
 * of a DIFFERENT weapon class (e.g. swapping the `ranged` pistol starter for
 * an `arcane` boss-chest drop).
 *
 * The evaluator scores a candidate on its own combat/stat merits, but it has
 * no model for the run's accumulated **weapon-class skill** (the slow-levelling
 * damage-focus skill) nor for the class-specific engagement behaviour the AI
 * has been running all floor. Switching class mid-run therefore silently
 * discards that investment: measured on Floor 1 seeds 1-3, an unrestricted
 * swap turned three victories into three timeouts. Changing class stays a
 * deliberate, separately-budgeted decision (the merchant weapon intent);
 * maintenance swaps upgrade WITHIN the class the run is already levelling.
 *
 * Non-weapon static items and non-weapon candidates are unaffected: only a
 * slot whose static occupant is a weapon is class-gated, and a candidate with
 * no active weapon snapshot can never target a hand slot held by one.
 */
function displacesIncompatibleStaticWeaponClass(
  instance: GeneratedEquipmentInstanceV1,
  staticWeaponClassBySlot: ReadonlyMap<EquipmentSlotId, WeaponClassSkillId>,
): boolean {
  const candidateClass = instance.frozen.activeWeaponSnapshot?.weaponClassSkillId ?? null;
  return instance.frozen.slots.some((slotId) => {
    const staticClass = staticWeaponClassBySlot.get(slotId);
    if (staticClass === undefined) return false;
    return candidateClass !== staticClass;
  });
}

/** True when `instance` would occupy at least one slot in `protectedSlots`. */
function instanceOccupiesProtectedSlot(
  instance: GeneratedEquipmentInstanceV1,
  protectedSlots: ReadonlySet<EquipmentSlotId>,
): boolean {
  return instance.frozen.slots.some((slotId) => protectedSlots.has(slotId));
}

/**
 * Simple, intentionally non-exhaustive affinity heuristic: weight the
 * player's current weapon-type tag (magic vs. physical, matching the
 * evaluator's own `affinityValue` classification) and reward any
 * ability-granting candidate, so the greedy loop mildly prefers loadouts
 * that stay consistent with the current build rather than thrashing between
 * unrelated playstyles.
 *
 * Reads the whole snapshot (generated AND modelled static equipment) so the
 * very first comparison — a bag candidate against a static starter weapon —
 * uses the player's real weapon affinity instead of no weapon at all.
 */
function deriveAffinityTagWeights(snapshot: EquipmentLoadoutSnapshot): Record<string, number> {
  const weights: Record<string, number> = {
    'active-ability': 1,
    'passive-ability': 1,
  };
  const generatedWeapon =
    snapshot.equipped.find((instance) => instance.frozen.activeWeaponSnapshot !== null)?.frozen
      .activeWeaponSnapshot ?? null;
  const staticWeaponId =
    snapshot.staticEquipped?.find((baseline) => baseline.weaponId !== null)?.weaponId ?? null;
  const weaponType =
    generatedWeapon?.weaponType ??
    (staticWeaponId === null ? undefined : getWeaponDef(staticWeaponId)?.weaponType);
  if (weaponType !== undefined) {
    weights[weaponType === WeaponType.MAGIC ? 'magic' : 'physical'] = 3;
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

/**
 * Builds this iteration's equipment candidate pool from the player's bag and
 * the Quartermaster's current offers.
 *
 * Two filters apply, both explained via `decisions` telemetry:
 *  - Candidates that would occupy a slot held by a STATIC (non-generated)
 *    instance the evaluator cannot model — see
 *    {@link classifyStaticEquippedInstances} — are excluded so the loop never
 *    blindly displaces an item it cannot score. Static items that ARE
 *    modelled (e.g. the starter weapon) are scored as part of the current
 *    loadout instead, so a candidate may displace them on merit.
 *  - Quartermaster offers the shared purchase API already reports as
 *    unpurchasable (`!offer.canPurchase`, e.g. unaffordable, capacity-full,
 *    or sold-out) are excluded rather than silently dropped.
 *
 * Both skip reasons are logged at most once per visit via `loggedSkipKeys`
 * (keyed by instance/offer identity) — `buildEquipmentCandidates` is called
 * fresh every hill-climb iteration, and the same still-unavailable
 * instance/offer would otherwise re-log identically on every iteration.
 */
function buildEquipmentCandidates(
  world: GameWorld,
  playerEid: number,
  protectedSlots: ReadonlySet<EquipmentSlotId>,
  staticWeaponClassBySlot: ReadonlyMap<EquipmentSlotId, WeaponClassSkillId>,
  decisions: SettlementMaintenanceDecision[],
  loggedSkipKeys: Set<string>,
): EquipmentCandidateSet {
  const candidates: EquipmentLoadoutCandidate[] = [];
  const offerLookup = new Map<string, ShopOfferRef>();

  const bag = world.inventories.get(playerEid);
  for (const entry of bag ? listGeneratedEquipmentReferences(bag) : []) {
    const instance = getGeneratedEquipmentInstance(world, entry.instanceKey);
    if (!instance) continue;
    if (instanceOccupiesProtectedSlot(instance, protectedSlots)) {
      const skipKey = `protected:${instance.instanceId}`;
      if (!loggedSkipKeys.has(skipKey)) {
        loggedSkipKeys.add(skipKey);
        decisions.push({
          kind: 'skip',
          detail: `Skipping bag candidate '${instance.instanceId}': would displace an unmodelable statically-equipped item in slot(s) ${instance.frozen.slots.join(', ')}`,
        });
      }
      continue;
    }
    if (displacesIncompatibleStaticWeaponClass(instance, staticWeaponClassBySlot)) {
      const skipKey = `weapon-class:${instance.instanceId}`;
      if (!loggedSkipKeys.has(skipKey)) {
        loggedSkipKeys.add(skipKey);
        decisions.push({
          kind: 'skip',
          detail: `Skipping bag candidate '${instance.instanceId}': would displace the statically-equipped weapon with a different weapon class in slot(s) ${instance.frozen.slots.join(', ')}`,
        });
      }
      continue;
    }
    candidates.push({ instance, source: 'inventory', purchaseCost: 0 });
  }

  for (const offer of getQuartermasterOfferViews(world, playerEid)) {
    if (!offer.canPurchase) {
      const skipKey = `unpurchasable:${offer.stockId}::${offer.offerId}`;
      if (!loggedSkipKeys.has(skipKey)) {
        loggedSkipKeys.add(skipKey);
        decisions.push({
          kind: 'skip',
          detail: `Skipping Quartermaster offer '${offer.offerId}' (${offer.instanceId}): ${offer.purchaseFailure} (affordable=${offer.affordable}, capacityAvailable=${offer.capacityAvailable})`,
        });
      }
      continue;
    }
    const instance = getGeneratedEquipmentInstance(world, offer.instanceId);
    if (!instance) continue;
    if (instanceOccupiesProtectedSlot(instance, protectedSlots)) {
      const skipKey = `protected:${instance.instanceId}`;
      if (!loggedSkipKeys.has(skipKey)) {
        loggedSkipKeys.add(skipKey);
        decisions.push({
          kind: 'skip',
          detail: `Skipping shop candidate '${instance.instanceId}': would displace an unmodelable statically-equipped item in slot(s) ${instance.frozen.slots.join(', ')}`,
        });
      }
      continue;
    }
    if (displacesIncompatibleStaticWeaponClass(instance, staticWeaponClassBySlot)) {
      const skipKey = `weapon-class:${instance.instanceId}`;
      if (!loggedSkipKeys.has(skipKey)) {
        loggedSkipKeys.add(skipKey);
        decisions.push({
          kind: 'skip',
          detail: `Skipping shop candidate '${instance.instanceId}': would displace the statically-equipped weapon with a different weapon class in slot(s) ${instance.frozen.slots.join(', ')}`,
        });
      }
      continue;
    }
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
 * Options for {@link runEquipmentLoop}. All properties are optional so
 * callers that don't need non-default behaviour can omit the argument.
 */
interface EquipmentLoopRunOptions {
  /**
   * When `true`, restricts candidates to inventory items only; shop offers
   * (Quartermaster purchases) are filtered out.  Safe to call from anywhere
   * because it never attempts a purchase.
   */
  readonly inventoryOnly?: boolean;
  /**
   * When `true`, exits immediately — before building candidates — if the
   * player's bag contains no generated-equipment items.  Prevents the
   * relatively-expensive `buildEquipmentCandidates` / `getQuartermasterOfferViews`
   * call from running every tick when there is nothing to equip.
   */
  readonly bagEmptyShortCircuit?: boolean;
  /**
   * Optional label prefix prepended to equip-decision detail strings, e.g.
   * `"Eager-"` to distinguish eager-tick equips from settlement-visit equips
   * in telemetry. Defaults to an empty string.
   */
  readonly detailPrefix?: string;
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
 *
 * Behaviour is controlled by the optional {@link EquipmentLoopRunOptions}
 * argument, which lets callers restrict to inventory-only candidates,
 * short-circuit on an empty bag, and prefix telemetry labels — so the
 * eager-tick and settlement-visit paths share one implementation instead of
 * maintaining parallel copies. There is deliberately NO safe-context bypass:
 * `equipFromBag` enforces the same gate the human Equipment panel does.
 */
function runEquipmentLoop(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
  options?: EquipmentLoopRunOptions,
): SettlementMaintenanceTerminationReason {
  // The AI equipment-maintenance feature flag gates all purchasing and equipping
  // of generated stock. When disabled, the loop is a no-op — the spec contract
  // ("disabling a consumer stops new generation and mutation through that
  // consumer") applies to this AI consumer just as it does to UX/world ones.
  if (!world.floor2EquipmentFlags.floor2EquipmentAiMaintenance) {
    return 'exhausted';
  }

  // Fast-path: skip snapshot + candidate build when the bag is empty and the
  // caller has opted in to the short-circuit (eager-tick path).
  if (options?.bagEmptyShortCircuit) {
    const bag = world.inventories.get(playerEid);
    if (!bag || listGeneratedEquipmentReferences(bag).length === 0) {
      return 'exhausted';
    }
  }

  const detailPrefix = options?.detailPrefix ?? '';
  const blacklistedInstanceIds = new Set<string>();
  const loggedSkipKeys = new Set<string>();
  for (let step = 0; step < EQUIPMENT_LOOP_CANDIDATE_CAP; step += 1) {
    // Recomputed per iteration: an accepted swap can retire a static item, so
    // the modelled/protected split is only valid for the current loadout.
    const { baselines, protectedSlots, staticWeaponClassBySlot } = classifyStaticEquippedInstances(
      world,
      playerEid,
    );
    const snapshot = buildEquipmentSnapshot(world, playerEid, baselines);
    const { candidates: allCandidates, offerLookup } = buildEquipmentCandidates(
      world,
      playerEid,
      protectedSlots,
      staticWeaponClassBySlot,
      decisions,
      loggedSkipKeys,
    );
    const candidates = allCandidates.filter(
      (candidate) =>
        !(options?.inventoryOnly && candidate.source !== 'inventory') &&
        !blacklistedInstanceIds.has(candidate.instance.instanceId),
    );
    if (candidates.length === 0) {
      return 'exhausted';
    }

    const evaluation = evaluateEquipmentLoadoutCandidates({
      current: snapshot,
      candidates,
      remainingEncounters: [CANONICAL_ENCOUNTER_FIXTURE],
      affinityTagWeights: deriveAffinityTagWeights(snapshot),
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
        detail: `${detailPrefix}Equip failed for '${instance.instanceId}': ${equipResult.reasons
          .map(describeEquipFailureReason)
          .join('; ')}; blacklisting and continuing`,
      });
      blacklistedInstanceIds.add(instance.instanceId);
      continue;
    }
    decisions.push({
      kind: 'equip-instance',
      detail: `${detailPrefix}Equipped '${instance.instanceId}' (swap score ${top.score.toFixed(2)})`,
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

export interface EagerMaintenanceTickOptions {
  /**
   * When `true`, skips achievement-reward claiming and the deferred-claim
   * retry.  Pass `true` when the settlement-return router is enabled so the
   * router's navigation signal (unclaimed achievements → positive utility) is
   * preserved: claiming eagerly would reduce utility to zero on the very next
   * frame, causing the router to defer its return trip before the player ever
   * reaches the settlement.  In that mode the settlement planner handles
   * achievement claiming once the player arrives.
   */
  readonly skipAchievementClaims?: boolean;
}

/**
 * Eager per-tick maintenance: claims all unlocked-but-unclaimed achievement
 * rewards, equips any generated-equipment bag items that improve the current
 * loadout, and fills open active-ability slots — all of which the human player
 * performs through the Achievements / Equipment / Abilities panels.
 *
 * **Parity contract:** every step here is gated on {@link isInSafeContext},
 * exactly as `MainGameScene.updateFeatureUnlocks` gates those three panels for
 * a human. The AI driver has hands, not privileges: it may only do what a
 * player standing in the same spot could do. Outside a safe context this is a
 * cheap no-op and the pending work is simply carried until the player next
 * reaches a safe room (see `settlement-return-router.ts`, which exists to make
 * that trip happen).
 *
 * Called unconditionally every tick. Boss chests are intentionally left to
 * {@link runSettlementMaintenancePlanner}: they require physical presence at
 * the settlement to keep the lifecycle test (chest → available → claimed) clean
 * and the UX review flow (chest opened in context) intact.
 * Skips the Quartermaster shop-purchase path (shop purchases require physical
 * presence at the Quartermaster and are handled by
 * {@link runSettlementMaintenancePlanner} once per settlement visit).
 *
 * All operations are idempotent: already-claimed achievements exit early, and
 * the equipment loop exits immediately when the bag is empty or no candidate
 * beats the current loadout.
 *
 * @param options.skipAchievementClaims — Set to `true` when
 *   settlement-return routing is active so the router's unclaimed-achievement
 *   signal is not consumed before the player reaches the settlement.
 */
export function runEagerMaintenanceTick(
  world: GameWorld,
  playerEid: number,
  options?: EagerMaintenanceTickOptions,
): void {
  // Parity gate: the Achievements, Equipment and Abilities panels are all
  // safe-context-only for a human, so the AI's equivalent of pressing those
  // buttons is too. Reset the equipment latch on the way out so the next
  // safe-room entry is treated as a fresh visit.
  if (!isInSafeContext(world)) {
    eagerEquipmentLatches.delete(world);
    return;
  }

  const decisions: SettlementMaintenanceDecision[] = [];

  // 1. Claim achievement rewards — skipped when the settlement-return router
  //    is enabled (the router uses unclaimed achievements as its navigation
  //    signal; claiming them here would drop utility to zero and cause the
  //    router to defer before the player reaches the settlement).
  let deferredAchievementIds: readonly string[] = [];
  if (!options?.skipAchievementClaims) {
    deferredAchievementIds = planAchievementClaims(world, decisions);
  }

  // 2. Equip bag candidates using the evaluator (inventory-only, no shop
  //    purchases). Gates on `floor2EquipmentAiMaintenance`; when the flag is
  //    off it is a cheap no-op.
  runBagOnlyEquipmentLoop(world, playerEid, decisions);

  // 3. Retry bag-full deferred claims now that equipping may have freed space.
  if (!options?.skipAchievementClaims) {
    retryDeferredAchievementClaims(world, decisions, deferredAchievementIds);
  }

  // 4. Fill any still-open active-ability slots with already-owned abilities.
  fillRemainingOwnedAbilities(world, playerEid, decisions);
}

/**
 * Per-world latch for the eager equipment loop. `signature` is the bag's
 * generated-equipment content at the moment the loop last ran to completion;
 * `null` means "no completed run in the current safe-context dwell".
 */
interface EagerEquipmentLatch {
  signature: string | null;
}

/**
 * Per-world "have we already run the eager equipment loop for this bag state"
 * latch. Deleted whenever the player leaves the safe context so the next entry
 * always re-evaluates. Keyed by `GameWorld` reference so each world/run tracks
 * its own state and stale entries are garbage-collected with the world.
 */
const eagerEquipmentLatches = new WeakMap<GameWorld, EagerEquipmentLatch>();

/**
 * Deterministic content signature of the player's generated-equipment bag
 * entries. Order-independent (sorted) so an inventory reshuffle that changes
 * nothing meaningful does not re-trigger the loop.
 */
function bagGeneratedSignature(world: GameWorld, playerEid: number): string {
  const bag = world.inventories.get(playerEid);
  if (!bag) return '';
  return listGeneratedEquipmentReferences(bag)
    .map((entry) => entry.instanceKey)
    .sort()
    .join('|');
}

/**
 * Bag-only wrapper around {@link runEquipmentLoop}: restricts to inventory
 * candidates (no shop purchases) and short-circuits when the bag is empty to
 * avoid the relatively-expensive `buildEquipmentCandidates` call every tick.
 *
 * Callers must already have confirmed {@link isInSafeContext}; the underlying
 * `equipFromBag` enforces that gate itself with no bypass, so this is
 * defence-in-depth rather than the only check.
 *
 * Runs the full candidate build only when there is genuinely something new to
 * consider — the first tick of a safe-context dwell, or any later tick where
 * the bag's generated-equipment contents changed (e.g. a chest opened while
 * standing in the newly-safe boss room). Every other tick costs one sorted
 * string build and an equality test.
 *
 * Inventory-only restriction: shop candidates require a Quartermaster purchase
 * (a location-gated operation) and are intentionally excluded so this function
 * is safe to call from anywhere a safe context exists.
 */
function runBagOnlyEquipmentLoop(
  world: GameWorld,
  playerEid: number,
  decisions: SettlementMaintenanceDecision[],
): SettlementMaintenanceTerminationReason {
  if (!world.floor2EquipmentFlags.floor2EquipmentAiMaintenance) {
    return 'exhausted';
  }
  const signature = bagGeneratedSignature(world, playerEid);
  const latch = eagerEquipmentLatches.get(world);
  if (latch && latch.signature === signature) {
    return 'exhausted';
  }
  const reason = runEquipmentLoop(world, playerEid, decisions, {
    inventoryOnly: true,
    bagEmptyShortCircuit: true,
    detailPrefix: 'Eager-',
  });
  const postSignature = bagGeneratedSignature(world, playerEid);
  if (reason === 'exhausted' || postSignature === signature) {
    eagerEquipmentLatches.set(world, { signature: postSignature });
  }
  return reason;
}

/**
 * Deterministic AI settlement-maintenance planner entry point. No-ops
 * (returns `ran: false`) unless the player is currently inside a legitimate
 * safe context. Floors with a settlement additionally require the player to be
 * inside that settlement's safe-room cluster. The full decision loop runs once
 * per continuous visit.
 *
 * Mirrors the no-op-gated call style of `autoFloor1ProgressionSystem` /
 * `autoFloor2ProgressionSystem` so it can be called unconditionally every
 * tick from the real pipeline.
 */
export function runSettlementMaintenancePlanner(world: GameWorld): SettlementMaintenanceResult {
  const settlement = world.floorExtendedState?.settlement;
  const floorMap = world.floorMap;
  const latch = settlementVisitLatches.get(world) ?? { wasInSettlement: false, processed: false };

  if (settlement && !floorMap) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return recordSettlementMaintenanceResult(world, {
      ran: false,
      terminationReason: 'no-opportunity',
      decisions: [],
    });
  }

  const playerEid = query(world.ecs, [Player])[0];
  if (playerEid === undefined) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return recordSettlementMaintenanceResult(world, {
      ran: false,
      terminationReason: 'no-opportunity',
      decisions: [],
    });
  }

  const inMaintenanceContext = settlement
    ? isPlayerInSettlementRoom(world, playerEid, settlement, floorMap!)
    : isInSafeContext(world);
  if (!inMaintenanceContext) {
    latch.wasInSettlement = false;
    latch.processed = false;
    settlementVisitLatches.set(world, latch);
    return recordSettlementMaintenanceResult(world, {
      ran: false,
      terminationReason: 'no-opportunity',
      decisions: [],
    });
  }

  if (latch.processed) {
    latch.wasInSettlement = true;
    settlementVisitLatches.set(world, latch);
    return recordSettlementMaintenanceResult(world, {
      ran: false,
      terminationReason: 'already-processed',
      decisions: [],
    });
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

  return recordSettlementMaintenanceResult(world, { ran: true, terminationReason, decisions });
}

/**
 * Deterministic string joining every currently-available maintenance
 * opportunity's stable id, sorted within each category so the result is
 * order-independent (same set of opportunities in any input order produces
 * the same fingerprint). Consumed by `settlement-return-router.ts` as an
 * anti-retrigger signal: servicing an unchanged opportunity set must not
 * re-arm the router even after its cooldown expires — only a genuinely new
 * or changed opportunity (a fresh unclaimed achievement, an open chest, a
 * better equipment swap, a fillable ability slot) changes the fingerprint.
 */
export function buildOpportunityFingerprint(input: {
  readonly unclaimedAchievementIds: readonly string[];
  readonly openBossChestIds: readonly string[];
  readonly bestSwapInstanceId: string | null;
  readonly fillableAbilityIds: readonly string[];
}): string {
  const parts: string[] = [];
  parts.push(...[...input.unclaimedAchievementIds].sort());
  parts.push(...[...input.openBossChestIds].sort().map((id) => `chest:${id}`));
  if (input.bestSwapInstanceId) {
    parts.push(`swap:${input.bestSwapInstanceId}`);
  }
  parts.push(...[...input.fillableAbilityIds].sort().map((id) => `ability:${id}`));
  return parts.join('|');
}

export interface SettlementMaintenanceOpportunityPreview {
  /** Count of unlocked-but-unclaimed achievement rewards, right now. */
  readonly unclaimedAchievements: number;
  /** Count of boss chests not yet in the `claimed` state, right now. */
  readonly openBossChests: number;
  /** Real top-ranked equipment-swap score from the actual evaluator; 0 if no swap beats the current loadout. */
  readonly topEquipmentSwapScore: number;
  /** Count of currently-owned-but-unequipped abilities that would fit in a still-open active-ability slot. */
  readonly fillableAbilitySlots: number;
  /** Deterministic sorted-id fingerprint of the above — see {@link buildOpportunityFingerprint}. */
  readonly opportunityFingerprint: string;
}

/**
 * Read-only preview of "how much settlement-maintenance opportunity exists
 * right now," reusing the SAME real, already-pure evaluators the planner
 * itself acts on (`buildEquipmentSnapshot`, `classifyStaticEquippedInstances`,
 * `buildEquipmentCandidates`, `evaluateEquipmentLoadoutCandidates`) rather
 * than a hand-rolled heuristic — this is what lets
 * `settlement-return-router.ts` decide whether returning to the settlement
 * is worth the travel using the actual top equipment-swap score the planner
 * would act on, not a guess.
 *
 * Never mutates gameplay state and never logs: `buildEquipmentCandidates` is
 * called with throwaway sink arrays (`decisions`/`loggedSkipKeys`) that are
 * discarded after this call, so a preview never emits a `decisions` entry or
 * accumulates skip-key state that could affect a later real call. Safe to
 * call every frame; callers that want to bound this cost (e.g. the return
 * router) should skip calling it while not eligible to act on the result.
 */
export function previewSettlementMaintenanceOpportunity(
  world: GameWorld,
  playerEid: number,
): SettlementMaintenanceOpportunityPreview {
  const unclaimedAchievementIds = [...world.achievements.unlockedIds]
    .filter((achievementId) => !isAchievementClaimed(world, achievementId))
    .sort();

  const openBossChestIds = [...world.bossChests.entries()]
    .filter(([, chest]) => chest.state !== 'claimed')
    .map(([chestId]) => chestId)
    .sort();

  const { baselines, protectedSlots, staticWeaponClassBySlot } = classifyStaticEquippedInstances(
    world,
    playerEid,
  );
  const previewDecisions: SettlementMaintenanceDecision[] = [];
  const previewLoggedSkipKeys = new Set<string>();
  const snapshot = buildEquipmentSnapshot(world, playerEid, baselines);
  const { candidates } = buildEquipmentCandidates(
    world,
    playerEid,
    protectedSlots,
    staticWeaponClassBySlot,
    previewDecisions,
    previewLoggedSkipKeys,
  );

  let topEquipmentSwapScore = 0;
  let bestSwapInstanceId: string | null = null;
  if (candidates.length > 0) {
    const evaluation = evaluateEquipmentLoadoutCandidates({
      current: snapshot,
      candidates,
      remainingEncounters: [CANONICAL_ENCOUNTER_FIXTURE],
      affinityTagWeights: deriveAffinityTagWeights(snapshot),
    });
    const top = evaluation.ranked[0];
    if (top && top.score > 0) {
      topEquipmentSwapScore = top.score;
      bestSwapInstanceId = top.candidate.instance.instanceId;
    }
  }

  const abilityState = getOrCreateAbilityState(world, playerEid);
  const openAbilitySlots = Math.max(
    0,
    ACTIVE_ABILITY_SLOT_LIMIT - abilityState.equippedActiveAbilityIds.length,
  );
  const fillableAbilityIds = [...(abilityState.ownedActiveAbilityIds ?? [])]
    .filter((abilityId) => !abilityState.equippedActiveAbilityIds.includes(abilityId))
    .sort()
    .slice(0, openAbilitySlots);

  const opportunityFingerprint = buildOpportunityFingerprint({
    unclaimedAchievementIds,
    openBossChestIds,
    bestSwapInstanceId,
    fillableAbilityIds,
  });

  return {
    unclaimedAchievements: unclaimedAchievementIds.length,
    openBossChests: openBossChestIds.length,
    topEquipmentSwapScore,
    fillableAbilitySlots: fillableAbilityIds.length,
    opportunityFingerprint,
  };
}
