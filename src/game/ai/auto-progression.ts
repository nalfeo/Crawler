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
import {
  executeMerchantWeaponPurchase,
  getMerchantWeaponIntent,
} from './merchant-weapon-intent.js';
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
 * loot still lying on the floor. Bounded (1800 frames = 30 s at 60 fps) so an
 * unreachable pickup can never hold a run hostage: once the budget is spent the
 * driver confirms the descend exactly as before.
 */
export const MAX_STAIR_DESCEND_DEFER_FRAMES = 1800;

/**
 * Per-world, per-floor deferral budget consumed so far. A `WeakMap` keyed on the
 * world keeps the counter deterministic and per-run (a fresh world starts at 0)
 * with no module-level state leaking across runs — same pattern the headless
 * runner uses for its Quartermaster restock latch. The inner key is the floor,
 * because the headless runner reuses one `GameWorld` across the whole run: a
 * shared counter would let unreachable Floor 1 loot silently spend Floor 2's
 * budget, disabling the hold exactly where it was designed to help.
 */
const stairDescendDeferFrames = new WeakMap<GameWorld, Map<StairDescendFloor, number>>();

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
 * would otherwise be confirmed this frame. The budget is a "frames spent standing
 * on the staircase waiting for loot" budget, not a wall clock: charging it during
 * the (arbitrarily long) walk to the stairs would drain it before it ever
 * protects anything.
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
  let budgets = stairDescendDeferFrames.get(world);
  if (!budgets) {
    budgets = new Map();
    stairDescendDeferFrames.set(world, budgets);
  }
  const spent = budgets.get(floor) ?? 0;
  if (spent >= MAX_STAIR_DESCEND_DEFER_FRAMES) {
    return false;
  }
  budgets.set(floor, spent + 1);
  return true;
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

    if (!spellBrokerPurchaseActive && getMerchantWeaponIntent(world).status === 'returning') {
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
      const candidateSpellIds = [
        spellIntent.spellId,
        ...getSpellBrokerOffers(world).map((offer) => offer.spellId),
      ].filter((spellId): spellId is string => spellId !== null);
      const spellId = candidateSpellIds.find((id) =>
        canPurchaseSpellBrokerSpell(world, playerEid, id),
      );
      if (spellId !== undefined && purchaseSpellBrokerSpell(world, playerEid, spellId)) {
        markSpellBrokerPurchased(world);
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
  const dx = playerX - objective.staircasePos.x;
  const dy = playerY - objective.staircasePos.y;
  if (Math.hypot(dx, dy) > objective.markerRadiusFt) {
    return;
  }
  if (
    shouldDeferStairDescend(
      world,
      'floor1',
      aiProvider?.resolveFloor1PlanningDeadlineMs?.(objective.deadlineMs) ??
        resolveFloor1AiCollapsePanicDeadlineMs(objective.deadlineMs),
    )
  ) {
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

  // Floor 2 has no collapse deadline, so the sweep window is time-unbounded —
  // only the frame budget bounds the hold.
  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const dx = playerX - floor2State.staircasePos.x;
  const dy = playerY - floor2State.staircasePos.y;
  if (Math.hypot(dx, dy) > FLOOR2_STAIR_MARKER_RADIUS_FT) {
    return;
  }
  if (shouldDeferStairDescend(world, 'floor2', null)) {
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

function equipPersonaPreferredGear(world: GameWorld, playerEid: number): boolean {
  const persona = getWeaponPersonaForWorld(world);
  const bag = world.inventories.get(playerEid);
  if (!persona || !bag) return false;
  const staticSlots = listStaticInventorySlots(bag);

  let equippedAny = false;
  if (staticSlots.some((slot) => slot.itemId === SHOPKEEPER_EQUIPMENT_ITEM_ID)) {
    const questGear = equipFromBag(world, playerEid, SHOPKEEPER_EQUIPMENT_ITEM_ID, { force: true });
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
    const result = equipFromBag(world, playerEid, bestCandidate.itemId, { force: true });
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
