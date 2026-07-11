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
import { equip } from '../../core/systems/equipmentSystem.js';
import type { EquipmentItemDef } from '../../shared/equipment-types.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../shared/constants.js';
import { getEquipmentDefForItem, isEquippableItem } from '../../shared/equipmentDefs.js';
import { removeItem } from '../../shared/inventory.js';
import type { PrimaryStatId } from '../../shared/stats.js';
import { AIState, type AIInputProvider } from './types.js';
import { NPC_INTERACTION_RADIUS_FT } from './bt-ai-tuning.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  meetTutorialGoon,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  meetShopkeeper,
  meetSpellQuestGiver,
  meetBroker,
  spendPoints,
} from '../index.js';
import { confirmFloor2StairDescend } from '../floor2Scenario.js';
import { computeAutoStatAllocation } from '../scenarios/playerStatAllocationPolicy.js';
import {
  computeWeaponPersonaStatAllocation,
  getWeaponPersonaForWorld,
  scoreEquipmentForPersona,
} from './weapon-personas.js';
export { computeAutoStatAllocation } from '../scenarios/playerStatAllocationPolicy.js';

/** Frames between auto NPC-talk attempts (debounce repeated `meet*` calls). */
export const NPC_INTERACTION_COOLDOWN = 30; // frames
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
  const isSeekingTutorialGoon =
    decision.state === AIState.EXPLORE && decision.reason.includes('Tutorial Goon');
  const tutorialSeekFallback = isSeekingTutorialGoon;
  if (decision.state !== AIState.INTERACT && !tutorialSeekFallback) {
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

  // For INTERACT state: use the real game proximity gate (nearbyPlayer).
  // For EXPLORE tutorial-goon fallback: keep the same ordinary bounded interaction
  // range as normal interaction semantics.
  let withinInteractionRange = targetNpc.nearbyPlayer;
  if (tutorialSeekFallback && !withinInteractionRange && targetNpc.defId === 'tutorial-goon') {
    const playerEids = query(world.ecs, [Player, Position]);
    const playerEid = playerEids[0];
    if (playerEid !== undefined) {
      const px = world.stores.position.x[playerEid] ?? 0;
      const py = world.stores.position.y[playerEid] ?? 0;
      if (decision.targetX !== null && decision.targetY !== null) {
        // Use the BT-selected objective anchor for the fallback proximity check.
        // This keeps interaction bounded while allowing tutorial-goon handoff when
        // the nearest reachable interaction tile is offset from NPC center.
        withinInteractionRange =
          Math.hypot(decision.targetX - px, decision.targetY - py) < NPC_INTERACTION_RADIUS_FT;
      } else {
        const nx = world.stores.position.x[targetEid] ?? 0;
        const ny = world.stores.position.y[targetEid] ?? 0;
        withinInteractionRange = Math.hypot(nx - px, ny - py) < NPC_INTERACTION_RADIUS_FT;
      }
    }
  }
  if (!withinInteractionRange) {
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
  weaponPersonas = false,
): void {
  if (!world.floorScenario) {
    return;
  }

  if (world.goalFlags.get('floor1-boss-battle-complete') === true && !world.featureUnlocks.spells) {
    // Pick the heal spell as the boss reward, not fireball. The spell is claimed
    // only AFTER the boss battle is already won, so it has zero combat value for
    // the fight itself; its entire value is post-boss survival. There is no
    // passive HP/regen on Floor 1 (see autoAllocateStatPoints note), so a player
    // who finishes the boss at low HP and still has to cross the swarm to the
    // staircase would otherwise be stuck retreating forever. Heal auto-casts on a
    // 30 HP health deficit (registry trigger) for 10 mp out of a 100 mp pool —
    // ~10 casts, far more than the descent needs — and lifts the AI back above
    // the 15% retreat threshold so it can actually reach the stairs.
    selectSpellFromBossBattle(world, playerEid, 'heal');
  }

  for (const [, instance] of world.npcs.entries()) {
    if (!instance.nearbyPlayer || instance.defId !== 'shopkeeper') {
      continue;
    }

    if (returnShopkeeperPrize(world, playerEid)) {
      break;
    }

    if (purchaseShopkeeperEquipment(world, playerEid)) {
      break;
    }
  }

  if (!weaponPersonas || !equipPersonaPreferredGear(world, playerEid)) {
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
  if (Math.hypot(dx, dy) <= objective.markerRadiusFt) {
    confirmFloor1StairDescend(world, playerEid);
  }
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

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const dx = playerX - floor2State.staircasePos.x;
  const dy = playerY - floor2State.staircasePos.y;
  if (Math.hypot(dx, dy) <= FLOOR2_STAIR_MARKER_RADIUS_FT) {
    confirmFloor2StairDescend(world, playerEid);
  }
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
  weaponPersonas = false,
): Partial<Record<PrimaryStatId, number>> {
  const persona = weaponPersonas ? getWeaponPersonaForWorld(world) : undefined;
  return persona
    ? computeWeaponPersonaStatAllocation(world, playerEid, available, persona)
    : computeAutoStatAllocation(world, playerEid, available);
}

export function autoAllocateStatPoints(
  world: GameWorld,
  playerEid: number,
  weaponPersonas = false,
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

  const currentStats = Object.fromEntries(
    Object.entries(world.stores.coreStatPoints).map(([stat, values]) => [
      stat,
      values[playerEid] ?? 0,
    ]),
  ) as Partial<Record<PrimaryStatId, number>>;
  const candidates = bag.slots
    .map((slot) => getEquipmentDefForItem(slot.itemId))
    .filter((def): def is EquipmentItemDef => def !== undefined && isEquippableItem(def.id))
    .sort(
      (a, b) =>
        scoreEquipmentForPersona(b, persona, currentStats) -
          scoreEquipmentForPersona(a, persona, currentStats) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  let equippedAny = false;
  for (const def of candidates) {
    const result = equip(world, playerEid, def, { force: true });
    if (result.ok) {
      removeItem(bag, def.id, 1);
      equippedAny = true;
    }
  }
  return equippedAny;
}
