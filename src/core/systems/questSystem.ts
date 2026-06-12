/**
 * Quest system — quest-log helpers + a deterministic evaluation pass.
 *
 * The quest log (`world.questLog`) is the single source of truth for the quest
 * tracker HUD and replaces Floor 1's ad-hoc objective booleans. `questSystem`
 * runs each tick: it evaluates every active quest's objectives against world
 * state (inventory, goal flags, equipment, talk latches), advances multistep
 * quests, completes quests (setting their `onCompleteGoalFlag`), and latches the
 * inventory/equipment feature unlocks.
 *
 * Deterministic: no Math.random(), no Date.now(). All inputs come from world state.
 */

import { query } from 'bitecs';
import { Player } from '../components.js';
import type { GameWorld } from '../world.js';
import { getItemCount, hasItem } from '../../shared/inventory.js';
import { getEquippableItemIds, isEquippableItem } from '../../shared/equipmentDefs.js';
import { getEquipmentState } from './equipmentSystem.js';
import {
  getQuestDef,
  objectiveTarget,
  SHOPKEEPER_FETCH_ITEM_ID,
  type QuestDef,
  type QuestObjectiveDef,
  type QuestState,
} from '../../shared/quest-types.js';

// ---------------------------------------------------------------------------
// Quest-log helpers
// ---------------------------------------------------------------------------

function findPlayer(world: GameWorld): number | undefined {
  return query(world.ecs, [Player])[0];
}

function createQuestState(questId: string, tracked: boolean): QuestState {
  return { questId, status: 'active', tracked, progress: {}, done: {} };
}

/**
 * Add a quest to the log (idempotent). The first accepted quest becomes the
 * tracked quest automatically.
 */
export function acceptQuest(world: GameWorld, questId: string): QuestState | undefined {
  const def = getQuestDef(questId);
  if (!def) {
    return undefined;
  }
  const existing = world.questLog.get(questId);
  if (existing) {
    return existing;
  }
  const hasTracked = [...world.questLog.values()].some((q) => q.tracked && q.status === 'active');
  const state = createQuestState(questId, !hasTracked);
  world.questLog.set(questId, state);
  return state;
}

/** Active quests, in insertion order. */
export function getActiveQuests(world: GameWorld): QuestState[] {
  return [...world.questLog.values()].filter((q) => q.status === 'active');
}

/** The currently-tracked active quest, if any. */
export function getTrackedQuest(world: GameWorld): QuestState | undefined {
  return getActiveQuests(world).find((q) => q.tracked);
}

/** Focus the tracker on a single active quest, clearing the flag on others. */
export function setTrackedQuest(world: GameWorld, questId: string): void {
  for (const quest of world.questLog.values()) {
    quest.tracked = quest.questId === questId && quest.status === 'active';
  }
}

/** Latch a `talk` objective complete (e.g. the player spoke to an NPC). */
export function notifyQuestTalk(world: GameWorld, npcId: string): void {
  for (const quest of world.questLog.values()) {
    if (quest.status !== 'active') {
      continue;
    }
    const def = getQuestDef(quest.questId);
    if (!def) {
      continue;
    }
    for (const objective of def.objectives) {
      if (objective.kind === 'talk' && objective.npcId === npcId) {
        quest.done[objective.id] = true;
      }
    }
  }
}

/** Set the absolute progress of a `counter` objective (e.g. kill tally). */
export function setQuestCounter(
  world: GameWorld,
  questId: string,
  objectiveId: string,
  value: number,
): void {
  const quest = world.questLog.get(questId);
  if (!quest) {
    return;
  }
  quest.progress[objectiveId] = Math.max(0, Math.floor(value));
}

// ---------------------------------------------------------------------------
// Objective evaluation
// ---------------------------------------------------------------------------

export interface QuestObjectiveView {
  readonly def: QuestObjectiveDef;
  readonly current: number;
  readonly target: number;
  readonly complete: boolean;
  /** True for the active step of a multistep quest (first incomplete objective). */
  readonly active: boolean;
  /** True when this objective should be hidden until earlier ones complete. */
  readonly hidden: boolean;
}

function objectiveProgress(
  world: GameWorld,
  quest: QuestState,
  objective: QuestObjectiveDef,
  playerEid: number | undefined,
): { current: number; target: number } {
  const target = objectiveTarget(objective);
  switch (objective.kind) {
    case 'counter':
      return { current: quest.progress[objective.id] ?? 0, target };
    case 'collect': {
      const bag = playerEid === undefined ? undefined : world.inventories.get(playerEid);
      const current = bag && objective.itemId ? getItemCount(bag, objective.itemId) : 0;
      return { current, target };
    }
    case 'talk':
    case 'goal':
      return { current: isLatchedComplete(world, quest, objective, playerEid) ? 1 : 0, target: 1 };
    case 'haveEquippable':
    case 'equip':
      return { current: isLatchedComplete(world, quest, objective, playerEid) ? 1 : 0, target: 1 };
    default:
      return { current: 0, target };
  }
}

function isLatchedComplete(
  world: GameWorld,
  quest: QuestState,
  objective: QuestObjectiveDef,
  playerEid: number | undefined,
): boolean {
  switch (objective.kind) {
    case 'talk':
      return quest.done[objective.id] === true;
    case 'goal':
      return objective.goalId ? world.goalFlags.get(objective.goalId) === true : false;
    case 'haveEquippable': {
      if (quest.done[objective.id] === true) {
        return true;
      }
      const bag = playerEid === undefined ? undefined : world.inventories.get(playerEid);
      if (!bag) {
        return false;
      }
      return getEquippableItemIds().some((itemId) => hasItem(bag, itemId));
    }
    case 'equip': {
      if (playerEid === undefined) {
        return false;
      }
      const state = getEquipmentState(world, playerEid);
      if (!state) {
        return false;
      }
      for (const instanceId of Object.values(state.equipped)) {
        if (instanceId === null) {
          continue;
        }
        const inst = state.instances.get(instanceId);
        if (inst && (!objective.equipmentId || inst.def.id === objective.equipmentId)) {
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

function isObjectiveComplete(
  world: GameWorld,
  quest: QuestState,
  objective: QuestObjectiveDef,
  playerEid: number | undefined,
): boolean {
  const { current, target } = objectiveProgress(world, quest, objective, playerEid);
  return current >= target;
}

/**
 * Build a tracker-friendly view of a quest's objectives. Multistep quests hide
 * objectives beyond the first incomplete one so the tracker reveals progress
 * one step at a time.
 */
export function getQuestObjectiveViews(
  world: GameWorld,
  quest: QuestState,
  playerEid?: number,
): QuestObjectiveView[] {
  const def = getQuestDef(quest.questId);
  if (!def) {
    return [];
  }
  const resolvedPlayer = playerEid ?? findPlayer(world);
  const views: QuestObjectiveView[] = [];
  let firstIncompleteSeen = false;
  for (const objective of def.objectives) {
    const { current, target } = objectiveProgress(world, quest, objective, resolvedPlayer);
    const complete = current >= target;
    const active = !complete && !firstIncompleteSeen;
    const hidden = !complete && firstIncompleteSeen;
    if (!complete) {
      firstIncompleteSeen = true;
    }
    views.push({ def: objective, current, target, complete, active, hidden });
  }
  return views;
}

/** True when every objective of the quest is satisfied. */
export function isQuestComplete(world: GameWorld, questId: string): boolean {
  const quest = world.questLog.get(questId);
  const def = getQuestDef(questId);
  if (!quest || !def) {
    return false;
  }
  if (quest.status === 'complete') {
    return true;
  }
  const player = findPlayer(world);
  return def.objectives.every((objective) => isObjectiveComplete(world, quest, objective, player));
}

// ---------------------------------------------------------------------------
// System pass
// ---------------------------------------------------------------------------

function latchFeatureUnlocks(world: GameWorld, playerEid: number | undefined): void {
  const bag = playerEid === undefined ? undefined : world.inventories.get(playerEid);
  if (!bag) {
    return;
  }
  // Inventory unlocks the moment the player picks up the merchant's fetch item.
  if (!world.featureUnlocks.inventory && hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID)) {
    world.featureUnlocks.inventory = true;
  }
  // Equipment unlocks once the player holds anything equippable (the purchase).
  if (!world.featureUnlocks.equipment && bag.slots.some((s) => isEquippableItem(s.itemId))) {
    world.featureUnlocks.equipment = true;
  }
}

function evaluateQuest(world: GameWorld, quest: QuestState, playerEid: number | undefined): void {
  const def: QuestDef | undefined = getQuestDef(quest.questId);
  if (!def || quest.status === 'complete') {
    return;
  }
  // Latch one-shot acquisition objectives so later steps (e.g. equipping, which
  // removes the item from the bag) don't retroactively un-satisfy them.
  for (const objective of def.objectives) {
    if (objective.kind === 'haveEquippable' && quest.done[objective.id] !== true) {
      if (isObjectiveComplete(world, quest, objective, playerEid)) {
        quest.done[objective.id] = true;
      }
    }
  }
  const complete = def.objectives.every((objective) =>
    isObjectiveComplete(world, quest, objective, playerEid),
  );
  if (complete) {
    quest.status = 'complete';
    quest.tracked = false;
    if (def.onCompleteGoalFlag) {
      world.goalFlags.set(def.onCompleteGoalFlag, true);
    }
  }
}

/** Deterministic quest evaluation pass. Shape: (world) => void. */
export function questSystem(world: GameWorld): void {
  const player = findPlayer(world);
  latchFeatureUnlocks(world, player);
  for (const quest of world.questLog.values()) {
    evaluateQuest(world, quest, player);
  }
  // Ensure exactly one tracked quest among the actives when possible.
  const active = getActiveQuests(world);
  if (active.length > 0 && !active.some((q) => q.tracked)) {
    active[0]!.tracked = true;
  }
}
