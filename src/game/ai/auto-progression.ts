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
import type { GameWorld } from '../../core/index.js';
import { AIState, type AIInputProvider, type RunnerPersonaValue } from './types.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  meetTutorialGoon,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  meetShopkeeper,
  meetSpellQuestGiver,
  spendPoints,
} from '../index.js';
import type { PrimaryStatId } from '../../shared/stats.js';
import { shouldDescendAtStairs } from './personas.js';

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
  if (decision.state !== AIState.INTERACT) {
    return lastInteractionFrame;
  }

  const targetEid = decision.targetEid;
  if (targetEid === null || targetEid === undefined || targetEid < 0) {
    return lastInteractionFrame;
  }

  const targetNpc = world.npcs.get(targetEid);
  if (!targetNpc?.nearbyPlayer) {
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

  return lastInteractionFrame;
}

export interface AutoFloor1ProgressionOptions {
  readonly runnerPersona?: RunnerPersonaValue;
}

export function autoFloor1ProgressionSystem(
  world: GameWorld,
  playerEid: number,
  options: AutoFloor1ProgressionOptions = {},
): void {
  if (!world.floor1) {
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

  equipPurchasedGear(world, playerEid);

  const objective = world.floor1.objective;
  if (!objective.staircaseUnlocked || objective.staircaseDiscovered) {
    return;
  }

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const dx = playerX - objective.staircasePos.x;
  const dy = playerY - objective.staircasePos.y;
  const timeRemainingMs = objective.deadlineMs - world.elapsedMs;
  const descentTimeRemainingMs = Number.isFinite(timeRemainingMs) ? timeRemainingMs : Infinity;
  if (
    Math.hypot(dx, dy) <= objective.markerRadiusFt &&
    shouldDescendAtStairs(options.runnerPersona, descentTimeRemainingMs)
  ) {
    confirmFloor1StairDescend(world, playerEid);
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
 * The starter sword's melee damage is a FIXED `def.baseDamage`, so extra damage
 * from Strength is wasted. That leaves armor (via Strength) and maxHp (via
 * Constitution), and the spend ORDER matters — allocating Constitution grants
 * the maxHp delta as immediate current HP (see statsSystem), so each level-up
 * Constitution point is a +10 HP heal. There is no passive regen on Floor 1.
 *
 * Spend order is tiered to front-load sustain:
 *   1. Strength → ARMOR_SWARM_FLOOR (5): 5 Strength pts → 5 armor, stops swarm bleed.
 *   2. Constitution → MAXHP_CUSHION_POINTS (6): 6 pts → +60 HP pool and immediate heals.
 *   3. Strength → ARMOR_BOSS_TARGET (11): 11 Strength pts → 11 armor, floors boss melee.
 *   4. Constitution: dump remainder for HP depth in the boss room.
 */
const ARMOR_SWARM_FLOOR = 5;
const MAXHP_CUSHION_POINTS = 6;
const ARMOR_BOSS_TARGET = 11;

/**
 * Compute the survival-tiered core-stat allocation for `available` unspent
 * points, WITHOUT spending them. Pure read of the player's `coreStatPoints`
 * stores; returns the per-stat point map to hand to `spendPoints` (or to drive
 * the level-up modal via `LevelUpUI.autoResolve`).
 *
 * Split out from {@link autoAllocateStatPoints} so the in-browser AI Runner Lab
 * can feed the same decision through the real level-up UX (the modal's
 * confirm/`spendPoints` path) instead of bypassing it, while the headless runner
 * — which has no DOM/modal — keeps spending directly. See the spend-order
 * rationale on the constants above.
 */
export function computeAutoStatAllocation(
  world: GameWorld,
  playerEid: number,
  available: number,
): Partial<Record<PrimaryStatId, number>> {
  const allocation: Partial<Record<PrimaryStatId, number>> = {};
  let remaining = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  if (remaining <= 0) {
    return allocation;
  }

  // Strength → armor (1 strength = 1 armor). Spend strength up to armor target.
  const spendStrengthUpTo = (target: number): void => {
    const current =
      (world.stores.coreStatPoints.strength[playerEid] ?? 0) + (allocation.strength ?? 0);
    const spend = Math.min(Math.max(0, target - current), remaining);
    if (spend > 0) {
      allocation.strength = (allocation.strength ?? 0) + spend;
      remaining -= spend;
    }
  };

  // Constitution → maxHp (+10 maxHp per point). Spend constitution up to target.
  const spendConstitutionUpTo = (targetPoints: number): void => {
    const current =
      (world.stores.coreStatPoints.constitution[playerEid] ?? 0) + (allocation.constitution ?? 0);
    const spend = Math.min(Math.max(0, targetPoints - current), remaining);
    if (spend > 0) {
      allocation.constitution = (allocation.constitution ?? 0) + spend;
      remaining -= spend;
    }
  };

  spendStrengthUpTo(ARMOR_SWARM_FLOOR);
  spendConstitutionUpTo(MAXHP_CUSHION_POINTS);
  spendStrengthUpTo(ARMOR_BOSS_TARGET);
  if (remaining > 0) {
    allocation.constitution = (allocation.constitution ?? 0) + remaining;
  }

  return allocation;
}

export function autoAllocateStatPoints(world: GameWorld, playerEid: number): void {
  const pl = world.playerLevel;
  if (pl.unspentPoints <= 0) {
    return;
  }
  spendPoints(world, computeAutoStatAllocation(world, playerEid, pl.unspentPoints));
}
