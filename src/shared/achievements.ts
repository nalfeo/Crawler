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

export const FLOOR1_ACHIEVEMENTS: readonly AchievementDef[] =
  parseAchievementCatalog(floor1Achievements);
export const FLOOR2_ACHIEVEMENTS: readonly AchievementDef[] = [];

const ACHIEVEMENTS_BY_FLOOR: Readonly<Record<AchievementFloor, readonly AchievementDef[]>> = {
  1: FLOOR1_ACHIEVEMENTS,
  2: FLOOR2_ACHIEVEMENTS,
};

const ALL_ACHIEVEMENTS = [...FLOOR1_ACHIEVEMENTS, ...FLOOR2_ACHIEVEMENTS];
const UNIQUE_ACHIEVEMENT_IDS = new Set(ALL_ACHIEVEMENTS.map((achievement) => achievement.id));
if (UNIQUE_ACHIEVEMENT_IDS.size !== ALL_ACHIEVEMENTS.length) {
  throw new Error('Achievement ids must be globally unique across floor catalogs');
}

export function isAchievementFloor(value: number): value is AchievementFloor {
  return value === 1 || value === 2;
}

export function getAchievementCatalogForFloor(floor: AchievementFloor): readonly AchievementDef[] {
  return ACHIEVEMENTS_BY_FLOOR[floor];
}

export function createEmptyAchievementFactState(): AchievementFactState {
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
    },
    booleanFacts: {
      staircaseBattleStarted: false,
      staircaseUnlocked: false,
      safeRoomDiscovered: false,
      equipmentUnlocked: false,
      staircaseDiscovered: false,
      runClearedFloor: false,
    },
    completedQuestIds: new Set(),
  };
}

export function getAchievementById(
  id: string,
  options?: { readonly floor?: AchievementFloor; readonly scope?: AchievementScope },
): AchievementDef | undefined {
  const floors = options?.floor === undefined ? ACHIEVEMENT_FLOORS : [options.floor];
  for (const floor of floors) {
    const achievement = ACHIEVEMENTS_BY_FLOOR[floor].find(
      (entry) => entry.id === id && (options?.scope === undefined || entry.scope === options.scope),
    );
    if (achievement) {
      return achievement;
    }
  }
  return undefined;
}

function collectIconBacklogItems(): AchievementArtBacklogItem[] {
  const iconToAchievements = new Map<string, string[]>();
  for (const achievement of FLOOR1_ACHIEVEMENTS) {
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
  for (const achievement of FLOOR1_ACHIEVEMENTS) {
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
