/**
 * Achievement catalog for Floor 1 progression and reward design.
 *
 * This module keeps achievements config-driven (JSON) and validates the data
 * at load time to fail fast on malformed entries.
 */
import { z } from 'zod';
import floor1Achievements from './data/achievements.floor1.json';
import { EQUIPMENT_REWARD_TIERS, type EquipmentRewardTier } from './generated-equipment-types.js';
import { ITEM_CATALOG, ItemRarity } from './items.js';

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

/**
 * Floor 1 achievement loot-box gold grant, monotonically increasing by tier.
 * Floor 1 loot boxes NEVER contain equipment (structurally guaranteed — the
 * `lootBox` reward variant has no equipment fields); they grant only gold
 * (scaled by tier) plus common crafting materials (see
 * {@link LOOT_BOX_MATERIAL_COUNT_BY_TIER} and
 * {@link FLOOR1_COMMON_CRAFTING_MATERIALS}). Numeric values are an explicit
 * design assumption (not specified by the reward-content brief) chosen to
 * roughly double per tier step.
 */
export const LOOT_BOX_GOLD_BY_TIER: Readonly<Record<LootBoxTier, number>> = Object.freeze({
  trash: 10,
  common: 25,
  uncommon: 50,
  rare: 100,
  epic: 200,
  legendary: 400,
  divine: 800,
});

/**
 * Floor 1 achievement loot-box crafting-material COUNT grant, monotonically
 * increasing by tier (paired with {@link LOOT_BOX_GOLD_BY_TIER}). Each unit is
 * one random pick (with replacement) from
 * {@link FLOOR1_COMMON_CRAFTING_MATERIALS}. Explicit design assumption, not
 * specified numerically by the brief.
 */
export const LOOT_BOX_MATERIAL_COUNT_BY_TIER: Readonly<Record<LootBoxTier, number>> = Object.freeze(
  {
    trash: 1,
    common: 2,
    uncommon: 3,
    rare: 4,
    epic: 5,
    legendary: 6,
    divine: 8,
  },
);

/**
 * Floor 1 "common crafting components" pool — derived DATA-DRIVEN from the
 * item catalog (Materials-tagged, Common-rarity items) rather than hardcoded,
 * so the pool tracks the catalog and can never silently drift to include a
 * higher rarity or a non-Materials item. This is the hard-gate-mandated
 * content: Floor 1 achievement boxes contain ONLY gold + common crafting
 * components, never equipment.
 */
export const FLOOR1_COMMON_CRAFTING_MATERIALS: readonly string[] = Object.freeze(
  ITEM_CATALOG.filter(
    (item) => item.rarity === ItemRarity.Common && item.tags.includes('Materials'),
  ).map((item) => item.id),
);

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
  'clearedFloorCount',
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
  | {
      /**
       * Floor 2 generated-equipment reward. Resolved ONCE at unlock into an
       * immutable, tier-scoped, single-item bundle; `bases` is the authored
       * candidate pool the resolver draws aligned/non-aligned picks from. It
       * must span both magic and physical affinity so both pools are non-empty
       * for any player build (the resolver fails closed otherwise). `tier`
       * gates the resolvable rarity pool — see
       * {@link EQUIPMENT_REWARD_TIER_RARITIES} in generated-equipment-types.ts;
       * NO tier defined here may ever resolve a Rare item.
       */
      readonly type: 'equipment';
      readonly bases: readonly string[];
      readonly tier: EquipmentRewardTier;
    }
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
      type: z.literal('equipment'),
      bases: z.array(z.string().min(1)).min(1),
      tier: z.enum(EQUIPMENT_REWARD_TIERS),
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

/**
 * Validate that every `current_run`-scoped achievement in the catalog only
 * references facts that are available at run scope. Throws on the first
 * violation. Accepts an empty array so it can be used by both
 * `parseAchievementCatalog` (non-empty authored data) and
 * `createAchievementCatalog` (runtime catalogs that may start empty).
 */
function validateCurrentRunFactCompatibility(catalog: readonly AchievementDef[]): void {
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
}

export function parseAchievementCatalog(rawCatalog: unknown): readonly AchievementDef[] {
  const catalog = achievementCatalogSchema.parse(rawCatalog);
  validateCurrentRunFactCompatibility(catalog);
  return catalog.map(removeUnlockCriteriaDuplication);
}

export function createAchievementCatalog(
  floor: AchievementFloor,
  rawCatalog: unknown,
): AchievementCatalog {
  const parsed = possiblyEmptyAchievementCatalogSchema.parse(rawCatalog);
  validateCurrentRunFactCompatibility(parsed);
  const all = parsed.map(removeUnlockCriteriaDuplication);
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
/**
 * Minimal Floor 2 catalog: one equipment-reward achievement per tier (tier1,
 * tier2, tier3) so the full tiered reward-content contract — real gold/materials
 * on Floor 1, tiered equipment on Floor 2 — is exercisable in-game/headless. The
 * reward `bases` span magic (`ember-wand`, `frost-crook`) and physical
 * (`iron-cleaver`, `ashwood-bow`) Floor 2 weapon bases — all have empty inherent
 * stat bonuses, so the Common item carries no non-armor stat bonus (rarity
 * contract). `iconId` is a placeholder key; no art is generated or required to
 * ship this slice.
 */
const FLOOR2_ACHIEVEMENT_DEFS: readonly unknown[] = [
  {
    id: 'floor2-field-kit',
    floor: 2,
    title: 'Floor 2 Field Kit',
    popupText: 'New achievement: Floor 2 Field Kit!',
    unlockCriteria: 'Defeat your first enemy on Floor 2.',
    details:
      'Unlock when you defeat your first enemy on Floor 2 to receive a starter equipment piece.',
    directorFlavor:
      'The prop department scraped together a starter kit from the discount bin. One piece, guaranteed Common quality, exactly the kind of inventory-management busywork the audience adores.',
    iconId: 'achv-floor2-field-kit-placeholder',
    difficulty: 'standard',
    reward: {
      type: 'equipment',
      tier: 'tier1',
      bases: [
        'weapon.iron-cleaver',
        'weapon.ashwood-bow',
        'weapon.ember-wand',
        'weapon.frost-crook',
      ],
    },
    unlockRules: [
      {
        type: 'numberCompare',
        fact: 'totalKills',
        op: '>=',
        value: 1,
      },
    ],
  },
  {
    id: 'floor2-second-wind',
    floor: 2,
    title: 'Floor 2 Second Wind',
    popupText: 'New achievement: Floor 2 Second Wind!',
    unlockCriteria: 'Defeat 10 enemies on Floor 2.',
    details:
      'Unlock by defeating 10 enemies on Floor 2 to receive a Common-or-Uncommon equipment piece.',
    directorFlavor:
      'The audience is warming up. So is the prop budget — this one might actually be Uncommon.',
    iconId: 'achv-floor2-second-wind-placeholder',
    difficulty: 'standard',
    reward: {
      type: 'equipment',
      tier: 'tier2',
      bases: [
        'weapon.iron-cleaver',
        'weapon.ashwood-bow',
        'weapon.ember-wand',
        'weapon.frost-crook',
      ],
    },
    unlockRules: [
      {
        type: 'numberCompare',
        fact: 'totalKills',
        op: '>=',
        value: 10,
      },
    ],
  },
  {
    id: 'floor2-veteran-cast',
    floor: 2,
    title: 'Floor 2 Veteran Cast',
    popupText: 'New achievement: Floor 2 Veteran Cast!',
    unlockCriteria: 'Defeat 30 enemies on Floor 2.',
    details:
      'Unlock by defeating 30 enemies on Floor 2 to receive an Uncommon-or-Common equipment piece.',
    directorFlavor:
      "You've earned top billing. The prop department's best (non-Rare) offering awaits.",
    iconId: 'achv-floor2-veteran-cast-placeholder',
    difficulty: 'hard',
    reward: {
      type: 'equipment',
      tier: 'tier3',
      bases: [
        'weapon.iron-cleaver',
        'weapon.ashwood-bow',
        'weapon.ember-wand',
        'weapon.frost-crook',
      ],
    },
    unlockRules: [
      {
        type: 'numberCompare',
        fact: 'totalKills',
        op: '>=',
        value: 30,
      },
    ],
  },
];
export const FLOOR2_ACHIEVEMENT_CATALOG = createAchievementCatalog(2, FLOOR2_ACHIEVEMENT_DEFS);
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

function collectIconBacklogItems(
  achievements: readonly AchievementDef[],
): AchievementArtBacklogItem[] {
  const iconToAchievements = new Map<string, string[]>();
  for (const achievement of achievements) {
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

function collectLootBoxBacklogItems(
  achievements: readonly AchievementDef[],
): AchievementArtBacklogItem[] {
  const tierToAchievements = new Map<LootBoxTier, string[]>();
  for (const achievement of achievements) {
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

/**
 * Derive the art backlog for a given achievement list. `ACHIEVEMENT_ART_BACKLOG`
 * uses the full catalog (all floors); the floor-1-scoped devtools canvas adapter
 * derives from `FLOOR1_ACHIEVEMENTS` only, so its parity guard reuses this with
 * the floor-1 list.
 */
export function buildAchievementArtBacklog(
  achievements: readonly AchievementDef[],
): readonly AchievementArtBacklogItem[] {
  return [...collectIconBacklogItems(achievements), ...collectLootBoxBacklogItems(achievements)];
}

export const ACHIEVEMENT_ART_BACKLOG: readonly AchievementArtBacklogItem[] =
  buildAchievementArtBacklog(ALL_ACHIEVEMENTS);

export const FLOOR1_ACHIEVEMENT_COUNT = FLOOR1_ACHIEVEMENTS.length;
