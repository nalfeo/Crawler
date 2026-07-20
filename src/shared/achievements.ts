/**
 * Achievement catalog for Floor 1 progression and reward design.
 *
 * This module keeps achievements config-driven (JSON) and validates the data
 * at load time to fail fast on malformed entries.
 */
import { z } from 'zod';
import floor1Achievements from './data/achievements.floor1.json';

export const LOOT_BOX_TIERS = [
  'trash',
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'divine',
] as const;

export type LootBoxTier = (typeof LOOT_BOX_TIERS)[number];

export const ACHIEVEMENT_DIFFICULTIES = ['basic', 'standard', 'hard', 'brutal'] as const;
export type AchievementDifficulty = (typeof ACHIEVEMENT_DIFFICULTIES)[number];
export const ACHIEVEMENT_SCOPES = ['floor', 'current_run'] as const;
export type AchievementScope = (typeof ACHIEVEMENT_SCOPES)[number];
export const ACHIEVEMENT_FLOORS = [1, 2] as const;
export type AchievementFloor = (typeof ACHIEVEMENT_FLOORS)[number];
export const ACHIEVEMENT_RULE_PHASES = ['tick', 'run_end_clear'] as const;
export type AchievementRulePhase = (typeof ACHIEVEMENT_RULE_PHASES)[number];
export const ACHIEVEMENT_NUMBER_FACTS = [
  'totalKills',
  'slimesKilled',
  'ratsKilled',
  'maxSkillLevel',
  'spentStatPoints',
  'goldCollected',
  'completedQuestCount',
  'questLogSize',
  'playerGold',
  'unlockedAbilityCount',
  'clearedFloorCount',
] as const;
export type AchievementNumberFact = (typeof ACHIEVEMENT_NUMBER_FACTS)[number];
export const ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS = [
  'totalKills',
  'maxSkillLevel',
  'spentStatPoints',
  'completedQuestCount',
  'questLogSize',
  'playerGold',
  'unlockedAbilityCount',
] as const;
export type AchievementCurrentRunNumberFact = (typeof ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS)[number];
export const ACHIEVEMENT_BOOLEAN_FACTS = [
  'staircaseBattleStarted',
  'staircaseUnlocked',
  'safeRoomDiscovered',
  'equipmentUnlocked',
  'staircaseDiscovered',
  'runClearedFloor',
] as const;
export type AchievementBooleanFact = (typeof ACHIEVEMENT_BOOLEAN_FACTS)[number];
export const ACHIEVEMENT_CURRENT_RUN_BOOLEAN_FACTS = [
  'equipmentUnlocked',
  'runClearedFloor',
] as const;
export type AchievementCurrentRunBooleanFact =
  (typeof ACHIEVEMENT_CURRENT_RUN_BOOLEAN_FACTS)[number];
export const ACHIEVEMENT_NUMBER_OPERATORS = ['>=', '>', '<=', '<', '==='] as const;
export type AchievementNumberOperator = (typeof ACHIEVEMENT_NUMBER_OPERATORS)[number];

export type AchievementReward =
  | { readonly type: 'lootBox'; readonly tier: LootBoxTier }
  | { readonly type: 'item'; readonly itemId: string }
  | { readonly type: 'directorMessage'; readonly message: string }
  | { readonly type: 'none' };

export type AchievementUnlockRule =
  | {
      readonly type: 'numberCompare';
      readonly fact: AchievementNumberFact;
      readonly op: AchievementNumberOperator;
      readonly value: number;
      readonly phase?: AchievementRulePhase;
    }
  | {
      readonly type: 'booleanIs';
      readonly fact: AchievementBooleanFact;
      readonly value: boolean;
      readonly phase?: AchievementRulePhase;
    }
  | {
      readonly type: 'allQuestsComplete';
      readonly questIds: readonly string[];
      readonly phase?: AchievementRulePhase;
    };


export interface AchievementDef {
  readonly id: string;
  readonly floor: AchievementFloor;
  readonly scope: AchievementScope;
  readonly title: string;
  readonly popupText: string;
  readonly unlockCriteria: string;
  readonly details: string;
  readonly directorFlavor: string;
  readonly iconId: string;
  readonly difficulty: AchievementDifficulty;
  readonly reward: AchievementReward;
  readonly unlockRules: readonly AchievementUnlockRule[];
}

export interface AchievementFactSnapshot {
  readonly numberFacts: Readonly<Record<AchievementNumberFact, number>>;
  readonly booleanFacts: Readonly<Record<AchievementBooleanFact, boolean>>;
  readonly questIds: readonly string[];
  readonly completedQuestIds: readonly string[];
  readonly reachedFloorIds: readonly number[];
  readonly clearedFloorIds: readonly number[];
}

export interface AchievementCatalog {
  readonly floor: AchievementFloor;
  readonly all: readonly AchievementDef[];
  readonly floorScoped: readonly AchievementDef[];
  readonly currentRunGlobal: readonly AchievementDef[];
}

export interface AchievementCatalogRegistry {
  readonly catalogs: readonly AchievementCatalog[];
  readonly all: readonly AchievementDef[];
  readonly byFloor: ReadonlyMap<AchievementFloor, AchievementCatalog>;
  readonly byId: ReadonlyMap<string, AchievementDef>;
}

export interface AchievementArtBacklogItem {
  readonly id: string;
  readonly kind: 'icon' | 'lootBox';
  readonly placeholderId: string;
  readonly description: string;
  readonly usedByAchievementIds: readonly string[];
}

export interface AchievementFactState {
  readonly numberFacts: Record<AchievementNumberFact, number>;
  readonly booleanFacts: Record<AchievementBooleanFact, boolean>;
  readonly completedQuestIds: Set<string>;
}

const achievementRewardSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('lootBox'),
      tier: z.enum(LOOT_BOX_TIERS),
    })
    .strict(),
  z
    .object({
      type: z.literal('item'),
      itemId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('directorMessage'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('none'),
    })
    .strict(),
]);

const achievementRulePhaseSchema = z.enum(ACHIEVEMENT_RULE_PHASES);
const achievementScopeSchema = z.enum(ACHIEVEMENT_SCOPES);
const achievementUnlockRuleSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('numberCompare'),
      fact: z.enum(ACHIEVEMENT_NUMBER_FACTS),
      op: z.enum(ACHIEVEMENT_NUMBER_OPERATORS),
      value: z.number().finite(),
      phase: achievementRulePhaseSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('booleanIs'),
      fact: z.enum(ACHIEVEMENT_BOOLEAN_FACTS),
      value: z.boolean(),
      phase: achievementRulePhaseSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('allQuestsComplete'),
      questIds: z.array(z.string().min(1)).min(1),
      phase: achievementRulePhaseSchema.optional(),
    })
    .strict(),
]);

const achievementSchema = z
  .object({
    id: z.string().min(1),
    floor: z.union([z.literal(1), z.literal(2)]),
    scope: achievementScopeSchema.default('floor'),
    title: z.string().min(1),
    popupText: z.string().min(1),
    unlockCriteria: z.string().min(1),
    details: z.string().min(1),
    directorFlavor: z.string().min(1),
    iconId: z.string().min(1),
    difficulty: z.enum(ACHIEVEMENT_DIFFICULTIES),
    reward: achievementRewardSchema,
    unlockRules: z.array(achievementUnlockRuleSchema),
  })
  .strict();

const achievementCatalogSchema = z.array(achievementSchema).min(1);
const possiblyEmptyAchievementCatalogSchema = z.array(achievementSchema);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function removeUnlockCriteriaDuplication(achievement: AchievementDef): AchievementDef {
  const unlockCriteria = achievement.unlockCriteria.trim();
  if (unlockCriteria.length === 0) return achievement;

  const escapedCriteria = escapeRegExp(unlockCriteria);
  const triggerPattern = new RegExp(`Trigger condition:\\s*${escapedCriteria}`, 'gi');
  const criteriaPattern = new RegExp(escapedCriteria, 'gi');

  const sanitizedFlavor = normalizeSpaces(
    achievement.directorFlavor
      .replace(triggerPattern, 'Trigger condition met')
      .replace(criteriaPattern, ''),
  );

  if (sanitizedFlavor.length === 0 || sanitizedFlavor === achievement.directorFlavor) {
    return achievement;
  }

  return {
    ...achievement,
    directorFlavor: sanitizedFlavor,
  };
}

export function parseAchievementCatalog(rawCatalog: unknown): readonly AchievementDef[] {
  const catalog = achievementCatalogSchema.parse(rawCatalog);
  // Validate that current_run achievements only reference current_run-compatible facts.
  for (const achievement of catalog) {
    if (achievement.scope !== 'current_run') continue;
    for (const rule of achievement.unlockRules) {
      if (
        rule.type === 'numberCompare' &&
        !ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS.includes(rule.fact as AchievementCurrentRunNumberFact)
      ) {
        throw new Error(
          `Achievement ${achievement.id} uses floor-scoped number fact "${rule.fact}" in current_run scope`,
        );
      }
      if (
        rule.type === 'booleanIs' &&
        !ACHIEVEMENT_CURRENT_RUN_BOOLEAN_FACTS.includes(
          rule.fact as AchievementCurrentRunBooleanFact,
        )
      ) {
        throw new Error(
          `Achievement ${achievement.id} uses floor-scoped boolean fact "${rule.fact}" in current_run scope`,
        );
      }
    }
  }
  return catalog.map(removeUnlockCriteriaDuplication);
}

export function createAchievementCatalog(
  floor: AchievementFloor,
  rawCatalog: unknown,
): AchievementCatalog {
  const all = possiblyEmptyAchievementCatalogSchema.parse(rawCatalog).map(removeUnlockCriteriaDuplication);
  const seenIds = new Set<string>();
  for (const achievement of all) {
    if (achievement.floor !== floor) {
      throw new Error(
        `Achievement ${achievement.id} belongs to floor ${achievement.floor}, not catalog floor ${floor}`,
      );
    }
    if (seenIds.has(achievement.id)) {
      throw new Error(`Duplicate achievement id in floor ${floor} catalog: ${achievement.id}`);
    }
    seenIds.add(achievement.id);
  }

  return {
    floor,
    all,
    floorScoped: all.filter((achievement) => achievement.scope !== 'current_run'),
    currentRunGlobal: all.filter((achievement) => achievement.scope === 'current_run'),
  };
}

export function createAchievementCatalogRegistry(
  catalogs: readonly AchievementCatalog[],
): AchievementCatalogRegistry {
  const orderedCatalogs = [...catalogs];
  const byFloor = new Map<AchievementFloor, AchievementCatalog>();
  const byId = new Map<string, AchievementDef>();
  for (const catalog of orderedCatalogs) {
    if (byFloor.has(catalog.floor)) {
      throw new Error(`Duplicate achievement catalog for floor ${catalog.floor}`);
    }
    byFloor.set(catalog.floor, catalog);
    for (const achievement of catalog.all) {
      if (byId.has(achievement.id)) {
        throw new Error(`Duplicate achievement id across catalogs: ${achievement.id}`);
      }
      byId.set(achievement.id, achievement);
    }
  }
  return {
    catalogs: orderedCatalogs,
    all: orderedCatalogs.flatMap((catalog) => catalog.all),
    byFloor,
    byId,
  };
}

export const FLOOR1_ACHIEVEMENT_CATALOG = createAchievementCatalog(1, floor1Achievements);
export const FLOOR2_ACHIEVEMENT_CATALOG = createAchievementCatalog(2, []);
export const ACHIEVEMENT_CATALOG_REGISTRY = createAchievementCatalogRegistry([
  FLOOR1_ACHIEVEMENT_CATALOG,
  FLOOR2_ACHIEVEMENT_CATALOG,
]);
export const ALL_ACHIEVEMENTS: readonly AchievementDef[] = ACHIEVEMENT_CATALOG_REGISTRY.all;
export const FLOOR1_ACHIEVEMENTS: readonly AchievementDef[] = FLOOR1_ACHIEVEMENT_CATALOG.all;
export const FLOOR2_ACHIEVEMENTS: readonly AchievementDef[] = FLOOR2_ACHIEVEMENT_CATALOG.all;

export function isAchievementFloor(value: number): value is AchievementFloor {
  return value === 1 || value === 2;
}

export function getAchievementCatalogForFloor(
  floor: number,
  registry: AchievementCatalogRegistry = ACHIEVEMENT_CATALOG_REGISTRY,
): AchievementCatalog | undefined {
  if (!isAchievementFloor(floor)) return undefined;
  return registry.byFloor.get(floor);
}

export function getCurrentRunGlobalAchievements(
  reachedFloorIds: readonly number[],
  registry: AchievementCatalogRegistry = ACHIEVEMENT_CATALOG_REGISTRY,
): readonly AchievementDef[] {
  const reachedFloors = new Set(reachedFloorIds);
  return registry.catalogs.flatMap((catalog) =>
    catalog.currentRunGlobal.filter((achievement) => reachedFloors.has(achievement.floor)),
  );
}

export function getAchievementById(
  id: string,
  registry: AchievementCatalogRegistry = ACHIEVEMENT_CATALOG_REGISTRY,
): AchievementDef | undefined {
  return registry.byId.get(id);
}

export function createEmptyAchievementFactSnapshot(): AchievementFactSnapshot {
  return {
    numberFacts: {
      totalKills: 0,
      slimesKilled: 0,
      ratsKilled: 0,
      maxSkillLevel: 0,
      spentStatPoints: 0,
      goldCollected: 0,
      completedQuestCount: 0,
      questLogSize: 0,
      playerGold: 0,
      unlockedAbilityCount: 0,
      clearedFloorCount: 0,
    },
    booleanFacts: {
      staircaseBattleStarted: false,
      staircaseUnlocked: false,
      safeRoomDiscovered: false,
      equipmentUnlocked: false,
      staircaseDiscovered: false,
      runClearedFloor: false,
    },
    questIds: [],
    completedQuestIds: [],
    reachedFloorIds: [],
    clearedFloorIds: [],
  };
}

const SUM_NUMBER_FACTS = new Set<AchievementNumberFact>([
  'totalKills',
  'slimesKilled',
  'ratsKilled',
  'goldCollected',
]);

function sortedUniqueStrings(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function sortedUniqueNumbers(left: readonly number[], right: readonly number[]): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

export function mergeAchievementFactSnapshots(
  carried: AchievementFactSnapshot,
  current: AchievementFactSnapshot,
): AchievementFactSnapshot {
  const questIds = sortedUniqueStrings(carried.questIds, current.questIds);
  const completedQuestIds = sortedUniqueStrings(
    carried.completedQuestIds,
    current.completedQuestIds,
  );
  const reachedFloorIds = sortedUniqueNumbers(carried.reachedFloorIds, current.reachedFloorIds);
  const clearedFloorIds = sortedUniqueNumbers(carried.clearedFloorIds, current.clearedFloorIds);
  const numberFacts = {} as Record<AchievementNumberFact, number>;
  for (const fact of ACHIEVEMENT_NUMBER_FACTS) {
    if (fact === 'completedQuestCount') {
      numberFacts[fact] = completedQuestIds.length;
    } else if (fact === 'questLogSize') {
      numberFacts[fact] = questIds.length;
    } else if (fact === 'clearedFloorCount') {
      numberFacts[fact] = clearedFloorIds.length;
    } else if (fact === 'playerGold') {
      numberFacts[fact] = current.numberFacts[fact];
    } else if (SUM_NUMBER_FACTS.has(fact)) {
      numberFacts[fact] = carried.numberFacts[fact] + current.numberFacts[fact];
    } else {
      numberFacts[fact] = Math.max(carried.numberFacts[fact], current.numberFacts[fact]);
    }
  }

  const booleanFacts = {} as Record<AchievementBooleanFact, boolean>;
  for (const fact of ACHIEVEMENT_BOOLEAN_FACTS) {
    booleanFacts[fact] = carried.booleanFacts[fact] || current.booleanFacts[fact];
  }
  booleanFacts.runClearedFloor = booleanFacts.runClearedFloor || clearedFloorIds.length > 0;

  return {
    numberFacts,
    booleanFacts,
    questIds,
    completedQuestIds,
    reachedFloorIds,
    clearedFloorIds,
  };
}

export function cloneAchievementFactSnapshot(
  snapshot: AchievementFactSnapshot | undefined,
): AchievementFactSnapshot {
  if (!snapshot) return createEmptyAchievementFactSnapshot();
  return {
    numberFacts: { ...snapshot.numberFacts },
    booleanFacts: { ...snapshot.booleanFacts },
    questIds: [...snapshot.questIds],
    completedQuestIds: [...snapshot.completedQuestIds],
    reachedFloorIds: [...snapshot.reachedFloorIds],
    clearedFloorIds: [...snapshot.clearedFloorIds],
  };
}

function collectIconBacklogItems(): AchievementArtBacklogItem[] {
  const iconToAchievements = new Map<string, string[]>();
  for (const achievement of ALL_ACHIEVEMENTS) {
    const list = iconToAchievements.get(achievement.iconId);
    if (list) {
      list.push(achievement.id);
    } else {
      iconToAchievements.set(achievement.iconId, [achievement.id]);
    }
  }

  return [...iconToAchievements.entries()].map(([placeholderId, usedByAchievementIds]) => ({
    id: `icon:${placeholderId}`,
    kind: 'icon',
    placeholderId,
    description: `Replace placeholder icon ${placeholderId} with a production icon set variant.`,
    usedByAchievementIds,
  }));
}

function collectLootBoxBacklogItems(): AchievementArtBacklogItem[] {
  const tierToAchievements = new Map<LootBoxTier, string[]>();
  for (const achievement of ALL_ACHIEVEMENTS) {
    if (achievement.reward.type !== 'lootBox') continue;
    const existing = tierToAchievements.get(achievement.reward.tier);
    if (existing) {
      existing.push(achievement.id);
    } else {
      tierToAchievements.set(achievement.reward.tier, [achievement.id]);
    }
  }

  return LOOT_BOX_TIERS.map((tier) => ({
    id: `lootBox:${tier}`,
    kind: 'lootBox',
    placeholderId: `loot-box-${tier}-placeholder`,
    description: `Create the ${tier} loot-box icon and open/closed reward reveal variants.`,
    usedByAchievementIds: tierToAchievements.get(tier) ?? [],
  }));
}

export const ACHIEVEMENT_ART_BACKLOG: readonly AchievementArtBacklogItem[] = [
  ...collectIconBacklogItems(),
  ...collectLootBoxBacklogItems(),
];

export const FLOOR1_ACHIEVEMENT_COUNT = FLOOR1_ACHIEVEMENTS.length;
