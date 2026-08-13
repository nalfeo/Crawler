/**
 * Quest data model — serializable quest/runtime types + a validated quest registry.
 *
 * Quest content is loaded from data packs and compiled at runtime. This keeps
 * quest definitions config-driven and allows procedural/AI providers to inject
 * compatible quest packs later without changing the quest evaluator.
 */
import { z } from 'zod';
import floor1QuestPack from './data/quests.floor1.json';
import floor2QuestPack from './data/quests.floor2.json';

/**
 * How an objective is satisfied.
 * - `counter`        — progress count driven by quest events (e.g. kill tallies).
 * - `collect`        — player inventory holds `target` of `itemId`.
 * - `talk`           — player has spoken to `npcId` (latched by quest events).
 * - `goal`           — a world goal flag (`goalId`) is true.
 * - `haveEquippable` — player inventory holds any item registered as equippable.
 * - `equip`          — player has `equipmentId` equipped.
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
  /**
   * When true, this quest is tracked mechanically (events fire, goal flag sets on
   * completion) but is NOT shown in the HUD quest tracker. Useful for passive
   * background conditions such as den-unlock kill counters.
   */
  readonly hidden?: boolean;
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

/** First Floor 1 quest: find the Welcome Office and hear the Tutorial Goon out. */
export const FLOOR1_FIND_WELCOME_QUEST_ID = 'floor1-find-welcome';
export const FLOOR1_TUTORIAL_QUEST_ID = 'floor1-tutorial';
export const FLOOR1_BOSS_UNLOCK_QUEST_ID = 'floor1-boss-unlock';
export const FLOOR1_MEET_NPCS_QUEST_ID = 'floor1-meet-npcs';
export const FLOOR1_BOSS_BATTLE_QUEST_ID = 'floor1-boss-battle';
export const FLOOR1_SHOP_QUEST_ID = 'floor1-shopkeeper-errand';
/** Final Floor 1 quest: defeat the Floor Boss and take the stairs to Floor 2. */
export const FLOOR1_LEAVE_FLOOR_QUEST_ID = 'floor1-leave-floor';
export const FLOOR2_FIND_SETTLEMENT_QUEST_ID = 'floor2-find-settlement';
export const FLOOR2_LEAVE_FLOOR_QUEST_ID = 'floor2-leave-floor';

/** The gross, rat/slime-themed key item the shopkeeper sends you to fetch. */
export const SHOPKEEPER_FETCH_ITEM_ID = 'glistening-rat-tail';
/** The merchant-quest objective that latches acquisition before the item can be returned. */
export const SHOPKEEPER_FETCH_OBJECTIVE_ID = 'fetch-prize';
/** The equipment the shopkeeper sells once you return his prize. */
export const SHOPKEEPER_EQUIPMENT_ITEM_ID = 'merchants-stained-charm';

// ---------------------------------------------------------------------------
// Quest templates + pack schema
// ---------------------------------------------------------------------------

export type QuestTemplateKind = 'goalFlag' | 'killTargets' | 'fetchAndEquip';

export interface GoalFlagTemplateDef {
  readonly kind: 'goalFlag';
  readonly objectiveId: string;
  readonly label: string;
  readonly goalId: string;
}

export interface KillTargetsTemplateDef {
  readonly kind: 'killTargets';
  readonly targets: readonly {
    readonly objectiveId: string;
    readonly label: string;
    readonly target: number;
  }[];
}

export interface FetchAndEquipTemplateDef {
  readonly kind: 'fetchAndEquip';
  readonly meetObjectiveId: string;
  readonly meetLabel: string;
  readonly npcId: string;
  readonly fetchObjectiveId: string;
  readonly fetchLabel: string;
  readonly itemId: string;
  readonly fetchTarget?: number;
  readonly returnObjectiveId: string;
  readonly returnLabel: string;
  readonly returnGoalId: string;
  readonly buyObjectiveId: string;
  readonly buyLabel: string;
  readonly equipObjectiveId: string;
  readonly equipLabel: string;
  readonly equipmentId: string;
}

export type QuestTemplateDef =
  | GoalFlagTemplateDef
  | KillTargetsTemplateDef
  | FetchAndEquipTemplateDef;

export interface QuestPackQuestSource {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly onCompleteGoalFlag?: string;
  readonly giverNpcId?: string;
  readonly hidden?: boolean;
  readonly objectives?: readonly QuestObjectiveDef[];
  readonly template?: QuestTemplateDef;
}

export interface QuestPackDef {
  readonly version: 1;
  readonly packId: string;
  readonly quests: readonly QuestPackQuestSource[];
}

const objectiveSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['counter', 'collect', 'talk', 'goal', 'haveEquippable', 'equip']),
    target: z.number().int().positive().optional(),
    itemId: z.string().min(1).optional(),
    npcId: z.string().min(1).optional(),
    goalId: z.string().min(1).optional(),
    equipmentId: z.string().min(1).optional(),
  })
  .strict();

const goalFlagTemplateSchema = z
  .object({
    kind: z.literal('goalFlag'),
    objectiveId: z.string().min(1),
    label: z.string().min(1),
    goalId: z.string().min(1),
  })
  .strict();

const killTargetsTemplateSchema = z
  .object({
    kind: z.literal('killTargets'),
    targets: z
      .array(
        z
          .object({
            objectiveId: z.string().min(1),
            label: z.string().min(1),
            target: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const fetchAndEquipTemplateSchema = z
  .object({
    kind: z.literal('fetchAndEquip'),
    meetObjectiveId: z.string().min(1),
    meetLabel: z.string().min(1),
    npcId: z.string().min(1),
    fetchObjectiveId: z.string().min(1),
    fetchLabel: z.string().min(1),
    itemId: z.string().min(1),
    fetchTarget: z.number().int().positive().optional(),
    returnObjectiveId: z.string().min(1),
    returnLabel: z.string().min(1),
    returnGoalId: z.string().min(1),
    buyObjectiveId: z.string().min(1),
    buyLabel: z.string().min(1),
    equipObjectiveId: z.string().min(1),
    equipLabel: z.string().min(1),
    equipmentId: z.string().min(1),
  })
  .strict();

const templateSchema = z.discriminatedUnion('kind', [
  goalFlagTemplateSchema,
  killTargetsTemplateSchema,
  fetchAndEquipTemplateSchema,
]);

const questPackQuestSourceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    onCompleteGoalFlag: z.string().min(1).optional(),
    giverNpcId: z.string().min(1).optional(),
    hidden: z.boolean().optional(),
    objectives: z.array(objectiveSchema).min(1).optional(),
    template: templateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasObjectives = Array.isArray(value.objectives);
    const hasTemplate = value.template !== undefined;
    if (hasObjectives === hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Quest source must provide exactly one of "objectives" or "template".',
      });
    }
  });

export const questPackSchema = z
  .object({
    version: z.literal(1),
    packId: z.string().min(1),
    quests: z.array(questPackQuestSourceSchema).min(1),
  })
  .strict();

function assertNever(value: never): never {
  throw new Error(`Unhandled quest template kind: ${JSON.stringify(value)}`);
}

function compileTemplate(template: QuestTemplateDef): QuestObjectiveDef[] {
  switch (template.kind) {
    case 'goalFlag':
      return [
        {
          id: template.objectiveId,
          label: template.label,
          kind: 'goal',
          goalId: template.goalId,
        },
      ];
    case 'killTargets':
      return template.targets.map((target) => ({
        id: target.objectiveId,
        label: target.label,
        kind: 'counter',
        target: target.target,
      }));
    case 'fetchAndEquip':
      return [
        {
          id: template.meetObjectiveId,
          label: template.meetLabel,
          kind: 'talk',
          npcId: template.npcId,
        },
        {
          id: template.fetchObjectiveId,
          label: template.fetchLabel,
          kind: 'collect',
          itemId: template.itemId,
          target: template.fetchTarget ?? 1,
        },
        {
          id: template.returnObjectiveId,
          label: template.returnLabel,
          kind: 'goal',
          goalId: template.returnGoalId,
        },
        {
          id: template.buyObjectiveId,
          label: template.buyLabel,
          kind: 'haveEquippable',
        },
        {
          id: template.equipObjectiveId,
          label: template.equipLabel,
          kind: 'equip',
          equipmentId: template.equipmentId,
        },
      ];
  }
  return assertNever(template);
}

function compileQuestSource(source: QuestPackQuestSource): QuestDef {
  const objectives = source.objectives ?? (source.template ? compileTemplate(source.template) : []);
  if (objectives.length === 0) {
    throw new Error(`Quest "${source.id}" has no objectives after compilation.`);
  }
  return {
    id: source.id,
    title: source.title,
    summary: source.summary,
    giverNpcId: source.giverNpcId,
    onCompleteGoalFlag: source.onCompleteGoalFlag,
    ...(source.hidden ? { hidden: true } : {}),
    objectives,
  };
}

function buildRegistry(packs: readonly QuestPackDef[]): ReadonlyMap<string, QuestDef> {
  const registry = new Map<string, QuestDef>();
  for (const pack of packs) {
    for (const source of pack.quests) {
      const compiled = compileQuestSource(source);
      registry.set(compiled.id, compiled);
    }
  }
  return registry;
}

const DEFAULT_QUEST_PACKS: readonly QuestPackDef[] = Object.freeze([
  questPackSchema.parse(floor1QuestPack),
  questPackSchema.parse(floor2QuestPack),
]);

let questRegistry: ReadonlyMap<string, QuestDef> = buildRegistry(DEFAULT_QUEST_PACKS);
let questPacks: readonly QuestPackDef[] = DEFAULT_QUEST_PACKS;

/** Replace loaded quest content with validated packs. */
export function installQuestPacks(packs: readonly QuestPackDef[]): void {
  const parsed = packs.map((pack) => questPackSchema.parse(pack));
  questPacks = parsed;
  questRegistry = buildRegistry(parsed);
}

/** Reset quest content back to bundled defaults. */
export function installDefaultQuestPacks(): void {
  questPacks = DEFAULT_QUEST_PACKS;
  questRegistry = buildRegistry(DEFAULT_QUEST_PACKS);
}

export function getQuestPacks(): readonly QuestPackDef[] {
  return questPacks;
}

export function getQuestDef(id: string): QuestDef | undefined {
  return questRegistry.get(id);
}

export function getAllQuestDefs(): QuestDef[] {
  return [...questRegistry.values()];
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

/**
 * Quest-indicator affordance state for a Floor 1 NPC.
 * - `actionable` — talking now can accept or advance a quest (yellow `!`).
 * - `accepted`   — NPC owns an active quest but has nothing new right now (grey `!`).
 * - `none`       — no quest affordance should be shown.
 */
export type NpcQuestIndicatorState = 'none' | 'actionable' | 'accepted';
