/**
 * Shared AI-driver auto-actions for Floor 1.
 *
 * These automate the no-UI / modal-driven actions a survival-minded player
 * performs by hand: spending earned stat points, claiming the boss-reward spell,
 * returning the shopkeeper prize, buying + equipping gear, confirming the stair
 * descend, and talking to NPCs. They are the AI *driver's hands*, not gameplay
 * cheats — every action is gated on legitimate game state.
 *
 * Both the headless runner and the in-browser AI-runner lab run these so the two
 * share identical AI-driver behavior. Without them the browser AI never spends
 * stat points (stays at base HP and death-spirals at low health) and stalls
 * forever on the boss-reward spell modal it has no way to dismiss.
 */
import { query } from 'bitecs';
import type { GameWorld } from '../../core/index.js';
import { Player, Position } from '../../core/index.js';
import {
  equipFromBag,
  getEffectiveStats,
  previewEquipDelta,
} from '../../core/systems/equipmentSystem.js';
import { isInSafeContext } from '../../core/safe-space.js';
import {
  executeMerchantWeaponPurchase,
  getMerchantWeaponIntent,
  merchantWeaponReserve,
} from './merchant-weapon-intent.js';
import { requiredShopPurchaseReserve } from './required-purchase-reserve.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../shared/constants.js';
import { getEquipmentDefForItem } from '../../shared/equipmentDefs.js';
import { NPC_INTERACT_RANGE_FT } from '../../shared/npc-types.js';
import { SHOPKEEPER_EQUIPMENT_ITEM_ID } from '../../shared/quest-types.js';
import { listStaticInventorySlots } from '../../shared/inventory.js';
import { PRIMARY_STATS, type PrimaryStatId, type StatId } from '../../shared/stats.js';
import { AIState, type AIInputProvider } from './types.js';
import {
  computeCollapsePanicProfile,
  resolveFloor1AiCollapsePanicDeadlineMs,
} from './bt-ai-provider.js';
import { LOOT_SWEEP_PANIC_THRESHOLD } from './bt-ai-tuning.js';
import { resolveManifestFloorCollapseState } from './collapse-deadline.js';
import { Gold, XpGem } from '../../core/components.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  getOfferedBossRewardSpellIds,
  meetTutorialGoon,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  meetShopkeeper,
  meetSpellQuestGiver,
  meetBroker,
  canPurchaseSpellBrokerSpell,
  isSpellBrokerSpellEligibleIgnoringGold,
  getSpellBrokerOffers,
  purchaseSpellBrokerSpell,
  spendPoints,
} from '../index.js';
import {
  ensureSpellBrokerDecision,
  isSpellBrokerPurchaseActive,
  markSpellBrokerPurchased,
} from './spell-broker-intent.js';
import { confirmFloor2StairDescend } from '../floor2Scenario.js';
import { computeAutoStatAllocation } from '../scenarios/playerStatAllocationPolicy.js';
import {
  computeWeaponPersonaStatAllocation,
  getWeaponPersonaForWorld,
  type WeaponPersona,
} from './weapon-personas.js';
export { computeAutoStatAllocation } from '../scenarios/playerStatAllocationPolicy.js';

/**
 * Frames the automated stair descend may be held back so the AI can sweep the
 * loot still lying on the floor, measured from the frame the run FIRST reached
 * the unlocked staircase. Bounded (1800 frames = 30 s at 60 fps) so an
 * unreachable pickup can never hold a run hostage: once the window closes the
 * driver confirms the descend exactly as before.
 */
export const MAX_STAIR_DESCEND_DEFER_FRAMES = 1800;

/**
 * Per-world, per-floor frame the run first stood on the unlocked staircase with
 * loot outstanding — the anchor the deferral window is measured from. A
 * `WeakMap` keyed on the world keeps it deterministic and per-run (a fresh world
 * has no anchor) with no module-level state leaking across runs — same pattern
 * the headless runner uses for its Quartermaster restock latch. The inner key is
 * the floor, because the headless runner reuses one `GameWorld` across the whole
 * run: a shared anchor would let unreachable Floor 1 loot silently consume
 * Floor 2's window, disabling the hold exactly where it was designed to help.
 */
const stairDescendDeferAnchorFrame = new WeakMap<GameWorld, Map<StairDescendFloor, number>>();

/** Floors that own an independent stair-descend deferral budget. */
type StairDescendFloor = 'floor1' | 'floor2';

/** True when any XP gem or gold pile is still lying on the floor. */
function hasUncollectedLoot(world: GameWorld): boolean {
  return query(world.ecs, [XpGem]).length > 0 || query(world.ecs, [Gold]).length > 0;
}

/**
 * Whether the driver should hold off confirming the stair descend for one more
 * frame so the AI can collect loot first.
 *
 * Descending destroys every pickup still on the floor (the scene restarts with a
 * fresh entity world) and the Floor 1 staircase sits inside the boss room, so
 * confirming the instant the boss dies throws away the boss drops the AI just
 * earned. A survival-minded player picks them up first.
 *
 * The hold is gated exactly like the AI's own loot sweep (`buildLootSweepBehavior`):
 * it surrenders under collapse pressure, so the descend is never delayed when
 * time actually matters. It is additionally capped by
 * {@link MAX_STAIR_DESCEND_DEFER_FRAMES} so unreachable loot cannot stall a run.
 *
 * Callers MUST check stair proximity first and only call this when the descend
 * would otherwise be confirmed this frame, so the (arbitrarily long) walk to the
 * stairs never consumes the window. The window then runs on world frames from
 * that first arrival rather than only on frames spent standing on the marker:
 * the AI's own pre-exit loot sweep is unbounded in range, so it repeatedly walks
 * back off the marker toward loot it may never reach. Charging only on-marker
 * frames let that oscillation stretch a 30 s hold into minutes of bouncing at
 * the exit (issue #3449: 285 s on seed 11 / throwing-knife).
 */
function shouldDeferStairDescend(
  world: GameWorld,
  floor: StairDescendFloor,
  panicDeadlineMs: number | null,
): boolean {
  if (!hasUncollectedLoot(world)) {
    return false;
  }
  if (panicDeadlineMs !== null) {
    const profile = computeCollapsePanicProfile({
      elapsedMs: world.elapsedMs,
      deadlineMs: panicDeadlineMs,
      staircaseUnlocked: true,
      staircaseDiscovered: false,
      playerToStairsTravelMs: null,
    });
    if (profile.beeline || profile.panic > LOOT_SWEEP_PANIC_THRESHOLD) {
      return false;
    }
  }
  let anchors = stairDescendDeferAnchorFrame.get(world);
  if (!anchors) {
    anchors = new Map();
    stairDescendDeferAnchorFrame.set(world, anchors);
  }
  const anchorFrame = anchors.get(floor);
  if (anchorFrame === undefined) {
    anchors.set(floor, world.frameCount);
    return true;
  }
  return world.frameCount - anchorFrame < MAX_STAIR_DESCEND_DEFER_FRAMES;
}

/** Frames between auto NPC-talk attempts (debounce repeated `meet*` calls). */
export const NPC_INTERACTION_COOLDOWN = 30; // frames

function isTargetedNpcActionable(
  world: GameWorld,
  aiProvider: AIInputProvider | undefined,
  targetEid: number,
  nearbyPlayer: boolean,
): boolean {
  if (nearbyPlayer) {
    return true;
  }
  if (!aiProvider) {
    return false;
  }

  const decision = aiProvider.getDecision();
  const intent = decision.npcInteraction;
  if (
    decision.state !== AIState.EXPLORE ||
    decision.targetEid !== targetEid ||
    !intent?.allowWhileExploring ||
    intent.npcEid !== targetEid ||
    decision.targetX === null ||
    decision.targetY === null
  ) {
    return false;
  }

  const playerEids = query(world.ecs, [Player, Position]);
  const playerEid = playerEids[0];
  if (playerEid === undefined) {
    return false;
  }
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;
  const npcX = world.stores.position.x[targetEid];
  const npcY = world.stores.position.y[targetEid];
  if (npcX === undefined || npcY === undefined) {
    return false;
  }
  return Math.hypot(npcX - px, npcY - py) <= NPC_INTERACT_RANGE_FT;
}

/**
 * Headless-compatible NPC interaction system.
 * Automatically meets NPCs when the player is nearby (simulates pressing E).
 */
export function autoNpcInteractionSystem(
  world: GameWorld,
  aiProvider: AIInputProvider,
  lastInteractionFrame: number,
  currentFrame: number,
  cooldown: number,
): number {
  if (currentFrame - lastInteractionFrame < cooldown) {
    return lastInteractionFrame;
  }

  const decision = aiProvider.getDecision();
  const exploreInteractionFallback =
    decision.state === AIState.EXPLORE && decision.npcInteraction?.allowWhileExploring === true;
  if (decision.state !== AIState.INTERACT && !exploreInteractionFallback) {
    return lastInteractionFrame;
  }

  const targetEid = decision.targetEid;
  if (targetEid === null || targetEid === undefined || targetEid < 0) {
    return lastInteractionFrame;
  }

  const targetNpc = world.npcs.get(targetEid);
  if (!targetNpc) {
    return lastInteractionFrame;
  }

  if (!isTargetedNpcActionable(world, aiProvider, targetEid, targetNpc.nearbyPlayer)) {
    return lastInteractionFrame;
  }

  // Simulate pressing E to interact with the AI-targeted NPC only.
  if (targetNpc.defId === 'tutorial-goon') {
    meetTutorialGoon(world);
    return currentFrame;
  }
  if (targetNpc.defId === 'shopkeeper') {
    meetShopkeeper(world);
    return currentFrame;
  }
  if (targetNpc.defId === 'spell-quest-giver') {
    meetSpellQuestGiver(world);
    return currentFrame;
  }
  if (targetNpc.defId === 'the-broker') {
    meetBroker(world);
    return currentFrame;
  }

  // Unknown/unsupported NPC interaction: still advance cooldown so the AI can
  // retarget instead of hammering the same unsupported target every frame.
  return currentFrame;
}

export function autoFloor1ProgressionSystem(
  world: GameWorld,
  playerEid: number,
  aiProvider?: AIInputProvider,
  weaponPersonas = true,
): void {
  if (!world.floorScenario) {
    return;
  }

  const spellIntent = ensureSpellBrokerDecision(world);
  const spellBrokerPurchaseActive = isSpellBrokerPurchaseActive(spellIntent);

  // A merchant weapon that was bought but could not be equipped on the spot
  // (no safe context) is retried here rather than inside the shopkeeper loop
  // below: equipping from the bag needs no NPC, and the safe room the player
  // must reach to complete it is generally nowhere near the merchant.
  if (getMerchantWeaponIntent(world).status === 'awaiting-equip') {
    executeMerchantWeaponPurchase(world, playerEid);
  }

  if (world.goalFlags.get('floor1-boss-battle-complete') === true && !world.featureUnlocks.spells) {
    const offeredSpellIds = getOfferedBossRewardSpellIds(world);
    const offeredSpellId =
      offeredSpellIds.find((spellId) => spellId === 'heal') ?? offeredSpellIds[0];
    if (offeredSpellId !== undefined) {
      selectSpellFromBossBattle(world, playerEid, offeredSpellId);
    }
  }

  for (const [npcEid, instance] of world.npcs.entries()) {
    if (instance.defId !== 'shopkeeper') {
      continue;
    }
    if (!isTargetedNpcActionable(world, aiProvider, npcEid, instance.nearbyPlayer)) {
      continue;
    }

    if (returnShopkeeperPrize(world, playerEid)) {
      break;
    }

    if (purchaseShopkeeperEquipment(world, playerEid)) {
      break;
    }

    // Both optional purchases may now run in the same visit; the weapon
    // executor holds back `_spellPurchaseReserve` so buying a weapon can never
    // price the higher-value broker spell out of the run.
    if (getMerchantWeaponIntent(world).status === 'returning') {
      executeMerchantWeaponPurchase(world, playerEid);
      break;
    }
  }

  if (
    spellBrokerPurchaseActive &&
    world.featureUnlocks.spells &&
    (world.goalFlags.get('floor1-boss-battle-complete') === true ||
      world.goalFlags.get('floor1-boss-spellbook-claimed') === true)
  ) {
    const broker = [...world.npcs.entries()].find(
      ([, instance]) => instance.defId === 'spell-quest-giver',
    );
    if (broker && isTargetedNpcActionable(world, aiProvider, broker[0], broker[1].nearbyPlayer)) {
      // Only consider a different offer when the intended spell is
      // unavailable for a reason other than affordability (already
      // purchased/learned, no free ability slot, or no intended spell at
      // all). A run that is merely short on gold for its intended pick must
      // not skip ahead in the priced rack — that would silently buy a
      // cheaper spell while the intent still thinks it is farming the
      // pricier headline offer.
      const intendedSpellId = spellIntent.spellId;
      const intendedUnavailableForOtherReason =
        intendedSpellId === null ||
        !isSpellBrokerSpellEligibleIgnoringGold(world, playerEid, intendedSpellId);
      const candidateSpellIds = intendedUnavailableForOtherReason
        ? getSpellBrokerOffers(world).map((offer) => offer.spellId)
        : [intendedSpellId];
      // A repeat spell is the run's lowest-priority purchase: it exists to
      // absorb gold that has nowhere else to go, so it must leave a pending
      // weapon-class switch fully funded (see `merchantWeaponReserve`). The
      // headline first spell keeps its priority and ignores that reserve — but
      // NO spell, headline or repeat, may spend gold the run still owes the
      // *required* shopkeeper charm (see `requiredShopPurchaseReserve`), or the
      // AI arrives at the merchant broke and has to farm and walk back.
      const reserve =
        (spellIntent.purchaseCount > 0 ? merchantWeaponReserve(world) : 0) +
        requiredShopPurchaseReserve(world);
      const offerCost = (id: string): number =>
        getSpellBrokerOffers(world).find((offer) => offer.spellId === id)?.cost ?? 0;
      const spellId = candidateSpellIds.find(
        (id) =>
          canPurchaseSpellBrokerSpell(world, playerEid, id) &&
          world.playerGold - offerCost(id) >= reserve,
      );
      if (spellId !== undefined && purchaseSpellBrokerSpell(world, playerEid, spellId)) {
        markSpellBrokerPurchased(world, spellId);
        return;
      }
    }
  }

  const persona = weaponPersonas ? getWeaponPersonaForWorld(world) : undefined;
  if (persona) {
    equipPersonaPreferredGear(world, playerEid);
  } else {
    equipPurchasedGear(world, playerEid);
  }

  const objective = world.floorScenario.objective;
  if (!objective.staircaseUnlocked || objective.staircaseDiscovered) {
    return;
  }

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const floor1PanicDeadlineMs =
    aiProvider?.resolveFloor1PlanningDeadlineMs?.(objective.deadlineMs) ??
    resolveFloor1AiCollapsePanicDeadlineMs(objective.deadlineMs);
  const dx = playerX - objective.staircasePos.x;
  const dy = playerY - objective.staircasePos.y;
  if (Math.hypot(dx, dy) > objective.markerRadiusFt) {
    return;
  }
  if (shouldDeferStairDescend(world, 'floor1', floor1PanicDeadlineMs)) {
    return;
  }
  confirmFloor1StairDescend(world, playerEid);
}

export function autoFloor2ProgressionSystem(world: GameWorld, playerEid: number): void {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) {
    return;
  }
  if (
    !floor2State.staircaseUnlocked ||
    !floor2State.staircaseSpawned ||
    floor2State.staircaseDiscovered ||
    !floor2State.staircasePos
  ) {
    return;
  }

  // Floor 2's collapse deadline lives on its manifest timer rather than on a
  // Floor-1 objective, so resolve it explicitly: the descend-defer hold must
  // surrender under collapse pressure here exactly as it does on Floor 1.
  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const dx = playerX - floor2State.staircasePos.x;
  const dy = playerY - floor2State.staircasePos.y;
  if (Math.hypot(dx, dy) > FLOOR2_STAIR_MARKER_RADIUS_FT) {
    return;
  }
  if (
    shouldDeferStairDescend(
      world,
      'floor2',
      resolveManifestFloorCollapseState(world)?.deadlineMs ?? null,
    )
  ) {
    return;
  }
  confirmFloor2StairDescend(world, playerEid);
}

/**
 * Headless-only: spend earned level-up points the way a survival-minded player
 * would via the in-scene stat-allocation modal. The human-played scene exposes
 * a UI to spend `unspentPoints`; the headless runner has no UI, so we automate
 * it (same pattern as auto-talk / auto-buy / auto-equip). This is legitimate
 * earned progression, not a cheat.
 *
 * Strategy (deterministic, no randomness). With the core-stat system, points go
 * into PRIMARY_STATS (Strength, Constitution, …) which derive STAT_KEYS via
 * CORE_STAT_GAINS:
 *   - Strength  → +2 Damage · +1 Armor per point
 *   - Constitution → +10 Max HP per point
 *
 * The starter sword still uses fixed `def.baseDamage`, so Strength's flat
 * `Stats.damage` gain does not directly raise weapon base damage. However,
 * Strength now contributes `damagePercent`, so it still has live combat payoff
 * alongside armor. The spend ORDER still matters — allocating Constitution
 * grants the maxHp delta as immediate current HP (see statsSystem), so each
 * level-up Constitution point is a +10 HP heal. There is no passive regen on
 * Floor 1.
 *
 */
export function computeAiStatAllocation(
  world: GameWorld,
  playerEid: number,
  available: number,
  weaponPersonas = true,
): Partial<Record<PrimaryStatId, number>> {
  const persona = weaponPersonas ? getWeaponPersonaForWorld(world) : undefined;
  return persona
    ? computeWeaponPersonaStatAllocation(world, playerEid, available, persona)
    : computeAutoStatAllocation(world, playerEid, available);
}

export function autoAllocateStatPoints(
  world: GameWorld,
  playerEid: number,
  weaponPersonas = true,
): void {
  const pl = world.playerLevel;
  if (pl.unspentPoints <= 0) {
    return;
  }
  spendPoints(world, computeAiStatAllocation(world, playerEid, pl.unspentPoints, weaponPersonas));
}

/**
 * Equip the persona's preferred static gear from the bag.
 *
 * **Parity contract:** every `equipFromBag` call here goes through the same
 * safe-context gate the human Equipment panel is bound by — there is no
 * `force` bypass. Outside a safe room this is a no-op and the gear stays in
 * the bag until the player next stands somewhere they could legitimately open
 * the panel. Callers run this every tick, so a deferred equip is picked up
 * automatically on the next safe-room entry with no extra latching.
 */
function equipPersonaPreferredGear(world: GameWorld, playerEid: number): boolean {
  const persona = getWeaponPersonaForWorld(world);
  const bag = world.inventories.get(playerEid);
  if (!persona || !bag) return false;
  if (!isInSafeContext(world)) return false;
  const staticSlots = listStaticInventorySlots(bag);

  let equippedAny = false;
  if (staticSlots.some((slot) => slot.itemId === SHOPKEEPER_EQUIPMENT_ITEM_ID)) {
    const questGear = equipFromBag(world, playerEid, SHOPKEEPER_EQUIPMENT_ITEM_ID);
    equippedAny = questGear.ok || equippedAny;
  }
  while (true) {
    const currentStats = getEffectiveStats(world, playerEid);
    const currentUtility = scoreLoadoutForPersona(persona, currentStats);
    const bestCandidate = [...new Set(listStaticInventorySlots(bag).map((slot) => slot.itemId))]
      .map((itemId) => {
        const def = getEquipmentDefForItem(itemId);
        const preview = previewEquipDelta(world, playerEid, itemId);
        if (!def || !preview?.canEquip) {
          return undefined;
        }
        const nextStats = { ...currentStats };
        for (const stat of Object.keys(preview.deltas) as StatId[]) {
          nextStats[stat] = (nextStats[stat] ?? 0) + preview.deltas[stat];
        }
        const utilityGain = scoreLoadoutForPersona(persona, nextStats) - currentUtility;
        return utilityGain > 0 ? { itemId, utilityGain } : undefined;
      })
      .filter(
        (candidate): candidate is { itemId: string; utilityGain: number } =>
          candidate !== undefined,
      )
      .sort(
        (a, b) =>
          b.utilityGain - a.utilityGain || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
      )[0];
    if (!bestCandidate) {
      break;
    }
    const result = equipFromBag(world, playerEid, bestCandidate.itemId);
    if (!result.ok) {
      break;
    }
    equippedAny = true;
  }
  return equippedAny;
}

function scoreLoadoutForPersona(
  persona: WeaponPersona,
  stats: Partial<Readonly<Record<StatId, number>>>,
): number {
  let score = 0;
  for (const stat of PRIMARY_STATS) {
    score += Math.min(stats[stat] ?? 0, persona.minimumTargets[stat] ?? 0) * 100;
  }
  for (const [stat, weight] of Object.entries(persona.statWeights) as [StatId, number][]) {
    score += (stats[stat] ?? 0) * weight;
  }
  return score;
}
