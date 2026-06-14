/**
 * Quest data model — pure, serializable types plus the quest registry.
 *
 * Replaces the hardcoded Floor 1 objective booleans with a small data-driven
 * quest log. Quests are ordered lists of objectives; multistep quests reveal
 * their later objectives one at a time (Skyrim/WoW-style tracker). Evaluation
 * of objectives against world state lives in `src/core/systems/questSystem.ts` — this
 * module stays free of ECS/engine imports so it remains portable.
 */

/**
 * How an objective is satisfied.
 * - `counter`     — progress count driven by game code (e.g. kill tallies). `target` required.
 * - `collect`     — player inventory holds `target` of `itemId`.
 * - `talk`        — player has spoken to `npcId` (latched by `notifyQuestTalk`).
 * - `goal`        — a world goal flag (`goalId`) is true.
 * - `haveEquippable` — player inventory holds any item registered as equippable.
 * - `equip`       — player has `equipmentId` equipped.
 */
export type QuestObjectiveKind =
  | 'counter'
  | 'collect'
  | 'talk'
  | 'goal'
  | 'haveEquippable'
  | 'equip';

export interface QuestObjectiveDef {
  /** Unique within the quest. */
  readonly id: string;
  /** Tracker label, e.g. "Exterminate the rats". */
  readonly label: string;
  readonly kind: QuestObjectiveKind;
  /** Required count for `counter` / `collect` objectives. Defaults to 1. */
  readonly target?: number;
  /** Item slug for `collect`. */
  readonly itemId?: string;
  /** NPC id for `talk`. */
  readonly npcId?: string;
  /** Goal flag id for `goal`. */
  readonly goalId?: string;
  /** Equipment def id for `equip`. */
  readonly equipmentId?: string;
}

export interface QuestDef {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Ordered objectives. Multistep quests reveal later steps as earlier ones complete. */
  readonly objectives: readonly QuestObjectiveDef[];
  /** Goal flag set true when the quest completes (bridge to door-lock and other systems). */
  readonly onCompleteGoalFlag?: string;
  /** NPC that offers this quest, if any. */
  readonly giverNpcId?: string;
}

export type QuestStatus = 'active' | 'complete';

export interface QuestState {
  questId: string;
  status: QuestStatus;
  /** Whether this quest is the focused/expanded quest in the tracker. */
  tracked: boolean;
  /** objectiveId → current progress count (for counter/collect display). */
  progress: Record<string, number>;
  /** objectiveId → latched completion (for talk/goal one-shot objectives). */
  done: Record<string, boolean>;
}

/** Maximum number of active quests surfaced in the tracker at once. */
export const MAX_ACTIVE_QUESTS = 3;

// ---------------------------------------------------------------------------
// Floor 1 quest definitions
// ---------------------------------------------------------------------------

export const FLOOR1_TUTORIAL_QUEST_ID = 'floor1-tutorial';
export const FLOOR1_BOSS_UNLOCK_QUEST_ID = 'floor1-boss-unlock';
export const FLOOR1_SHOP_QUEST_ID = 'floor1-shopkeeper-errand';

/** The gross, rat/slime-themed key item the shopkeeper sends you to fetch. */
export const SHOPKEEPER_FETCH_ITEM_ID = 'glistening-rat-tail';
/** The equipment the shopkeeper sells once you return his prize. */
export const SHOPKEEPER_EQUIPMENT_ITEM_ID = 'merchants-stained-charm';

const FLOOR1_TUTORIAL_QUEST: QuestDef = {
  id: FLOOR1_TUTORIAL_QUEST_ID,
  title: 'Trial by XP',
  summary: 'Meet the Tutorial Goon, unlock experience, and hit level 2.',
  giverNpcId: 'tutorial-goon',
  onCompleteGoalFlag: 'floor1-leveling-quest-complete',
  objectives: [
    { id: 'reach-level-2', label: 'Reach level 2', kind: 'goal', goalId: 'floor1-reach-level-2' },
  ],
};

const FLOOR1_BOSS_UNLOCK_QUEST: QuestDef = {
  id: FLOOR1_BOSS_UNLOCK_QUEST_ID,
  title: 'Pest Control for Beginners',
  summary: 'Thin out rats and slimes to unlock the boss room door.',
  giverNpcId: 'tutorial-goon',
  onCompleteGoalFlag: 'floor1-goon-quest-complete',
  objectives: [
    { id: 'kill-rats', label: 'Exterminate rats', kind: 'counter', target: 6 },
    { id: 'kill-slimes', label: 'Squish slimes', kind: 'counter', target: 4 },
  ],
};

const FLOOR1_SHOP_QUEST: QuestDef = {
  id: FLOOR1_SHOP_QUEST_ID,
  title: "The Merchant's Disgusting Little Errand",
  summary:
    'A clammy shopkeeper will only trade with contestants who fetch him a very particular souvenir. Try not to think about what he does with it.',
  giverNpcId: 'shopkeeper',
  onCompleteGoalFlag: 'floor1-shop-quest-complete',
  objectives: [
    {
      id: 'meet-merchant',
      label: 'Introduce yourself to the merchant',
      kind: 'talk',
      npcId: 'shopkeeper',
    },
    {
      id: 'fetch-prize',
      label: 'Retrieve his "special" rat tail (dropped in a far dungeon room)',
      kind: 'collect',
      itemId: SHOPKEEPER_FETCH_ITEM_ID,
      target: 1,
    },
    {
      id: 'return-prize',
      label: 'Hand the merchant his prize (ew)',
      kind: 'goal',
      goalId: 'floor1-shop-prize-returned',
    },
    { id: 'buy-gear', label: 'Buy a piece of equipment', kind: 'haveEquippable' },
    {
      id: 'equip-gear',
      label: 'Equip your new gear',
      kind: 'equip',
      equipmentId: SHOPKEEPER_EQUIPMENT_ITEM_ID,
    },
  ],
};

const QUEST_REGISTRY: ReadonlyMap<string, QuestDef> = new Map([
  [FLOOR1_TUTORIAL_QUEST.id, FLOOR1_TUTORIAL_QUEST],
  [FLOOR1_BOSS_UNLOCK_QUEST.id, FLOOR1_BOSS_UNLOCK_QUEST],
  [FLOOR1_SHOP_QUEST.id, FLOOR1_SHOP_QUEST],
]);

export function getQuestDef(id: string): QuestDef | undefined {
  return QUEST_REGISTRY.get(id);
}

export function getAllQuestDefs(): QuestDef[] {
  return [...QUEST_REGISTRY.values()];
}

/** Resolve an objective's required count, defaulting to 1. */
export function objectiveTarget(objective: QuestObjectiveDef): number {
  return objective.target ?? 1;
}

/**
 * Stages of the Floor 1 shopkeeper errand, derived from world state.
 * - `not-met`        — player hasn't introduced themselves yet.
 * - `awaiting-prize` — quest accepted; go find the gross fetch item.
 * - `ready-to-buy`   — prize returned; the shop is open.
 * - `awaiting-equip` — equipment purchased; equip it to finish.
 * - `complete`       — errand done.
 */
export type ShopkeeperStage =
  | 'not-met'
  | 'awaiting-prize'
  | 'ready-to-buy'
  | 'awaiting-equip'
  | 'complete';
