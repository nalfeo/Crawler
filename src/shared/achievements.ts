/**
 * Achievement catalog for Floor 1 progression and reward design.
 *
 * This module keeps achievements config-driven (JSON) and validates the data
 * at load time to fail fast on malformed entries.
 */
import { z } from 'zod';
import floor1Achievements from './data/achievements.floor1.json';
import floor2Achievements from './data/achievements.floor2.json';
import { type EquipmentRewardTier } from './generated-equipment-types.js';
import { ITEM_CATALOG, ItemRarity } from './items.js';

/**
 * Reserved prefix for the boss-chest reward-bundle keyspace (ADR 0070). Boss
 * chests reuse achievements' generated-equipment-reward-bundle keyspace
 * (`world.generatedEquipmentRewardBundles`, keyed by achievement id OR
 * `boss-chest:<familyId>`), so an achievement id that happened to collide with
 * this prefix would alias two independent reward sources onto one bundle
 * entry. Achievement ids are content-authored (`src/shared/data/achievements*.json`),
 * so this is validated at catalog-load time rather than left to chance.
 */
export const BOSS_CHEST_ID_PREFIX = 'boss-chest:';

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

export function isLootBoxTier(value: string): value is LootBoxTier {
  return (LOOT_BOX_TIERS as readonly string[]).includes(value);
}

/**
 * Named loot-table discriminator for the `lootBox` achievement reward variant
 * (ADR 0069 amendment). Floor 1's `floor1-materials` table (gold + common
 * crafting materials, tiered by {@link LootBoxTier}) and Floor 2's
 * `floor2-generated-equipment` table (a single generated-equipment instance,
 * tiered by {@link Floor2AchievementLootTier}) are structurally different
 * payloads that both present to the player as "a loot box" — this
 * discriminator keeps them distinguishable at the type, schema, routing, and
 * persistence layers while sharing one player-facing `type: 'lootBox'`
 * concept, rather than reviving a separate `'equipment'` reward type.
 */
export const ACHIEVEMENT_LOOT_TABLES = ['floor1-materials', 'floor2-generated-equipment'] as const;
export type AchievementLootTable = (typeof ACHIEVEMENT_LOOT_TABLES)[number];

/**
 * Floor 2 achievement-reward tier vocabulary (ADR 0069 amendment). Player/
 * content-facing rarity names — NOT the internal `tier1`-`tier4`
 * {@link EquipmentRewardTier} keyspace the generated-equipment resolver and
 * boss chests use. `tier4` (the 85% Uncommon / 15% Rare pool) is reserved
 * exclusively for boss chests; it is deliberately absent here and MUST NEVER
 * appear in achievement content — see {@link FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER}
 * for the one-way mapping into the resolver's tier keyspace, applied at the
 * achievement-reward call sites (never inside the resolver itself).
 */
export const FLOOR2_ACHIEVEMENT_LOOT_TIERS = ['common', 'uncommon', 'rare'] as const;
export type Floor2AchievementLootTier = (typeof FLOOR2_ACHIEVEMENT_LOOT_TIERS)[number];

export function isFloor2AchievementLootTier(value: string): value is Floor2AchievementLootTier {
  return (FLOOR2_ACHIEVEMENT_LOOT_TIERS as readonly string[]).includes(value);
}

/**
 * Translates the player/content-facing {@link Floor2AchievementLootTier}
 * (`common`/`uncommon`/`rare`) into the internal {@link EquipmentRewardTier}
 * (`tier1`/`tier2`/`tier3`) the generated-equipment reward-bundle resolver and
 * claim path speak. Applied exactly once, at each achievement-reward call
 * site that invokes the resolver/claim functions — the resolver's own
 * tier keyspace and 85/15 `tier4` boss-chest contract are UNCHANGED by this
 * mapping (ADR 0068's resolver boundary is not touched).
 */
export const FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER: Readonly<
  Record<Floor2AchievementLootTier, EquipmentRewardTier>
> = Object.freeze({
  common: 'tier1',
  uncommon: 'tier2',
  rare: 'tier3',
});

/**
 * Achievement IDs that briefly resolved at `tier4` before the authored tier
 * model tightened to tier1–tier3 (see ADR 0069 amendment). Persisted `tier4`
 * bundles and presentations for these IDs are preserved verbatim at
 * restore/claim time so the already-generated instances are never re-rolled
 * or altered. Any achievement ID outside this set rejects a `tier4` bundle or
 * presentation as tampered/stale state (fail-closed). Shared from
 * `src/shared/` so both the core claim path (`achievementRewards.ts`) and the
 * game carryover restore validator (`playerCarryover.ts`) use the single
 * canonical allowlist without duplication.
 */
export const LEGACY_TIER4_ACHIEVEMENT_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'floor2-family-annihilator',
  'floor2-floor-cleared',
  'floor2-scorched-earth',
]);

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
const LOOT_BOX_GOLD_BY_TIER: Readonly<Record<LootBoxTier, number>> = Object.freeze({
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
const FLOOR1_COMMON_CRAFTING_MATERIALS: readonly string[] = Object.freeze(
  ITEM_CATALOG.filter(
    (item) => item.rarity === ItemRarity.Common && item.tags.includes('Materials'),
  ).map((item) => item.id),
);

/**
 * Floor 2 crafting-material pool — the Floor 1 common pool PLUS the catalog's
 * Uncommon Materials (`gold-nugget`, `hardite-plank`, `ectoplasm-glob`,
 * `lava-glass`, …), derived DATA-DRIVEN from the item catalog exactly like
 * {@link FLOOR1_COMMON_CRAFTING_MATERIALS} so it can never silently drift to a
 * non-Materials item. Floor 2 is a strictly richer floor than Floor 1, so its
 * loot boxes may roll the better components Floor 1's never can — but still
 * NEVER equipment (the `lootBox` bundle shape structurally carries none) and
 * never above Uncommon.
 */
const FLOOR2_CRAFTING_MATERIALS: readonly string[] = Object.freeze(
  ITEM_CATALOG.filter(
    (item) =>
      (item.rarity === ItemRarity.Common || item.rarity === ItemRarity.Uncommon) &&
      item.tags.includes('Materials'),
  ).map((item) => item.id),
);

/**
 * Floor 2 loot-box gold grant per achievement tier — deliberately ABOVE
 * {@link LOOT_BOX_GOLD_BY_TIER}'s Floor 1 amounts for the same tier name
 * (3× — 75/150/300 vs 25/50/100), because Floor 2's economy (equipment,
 * settlement shops, the Broker) prices everything higher and a Floor 2
 * consolation payout must stay meaningful next to a generated-equipment
 * drop. Explicit design assumption, mirroring the Floor 1 table's own
 * roughly-doubling-per-tier shape.
 */
const FLOOR2_LOOT_BOX_GOLD_BY_TIER: Readonly<Record<Floor2AchievementLootTier, number>> =
  Object.freeze({
    common: 75,
    uncommon: 150,
    rare: 300,
  });

// Test-scaffolding exports intentionally prefixed with `_` to satisfy
// check:test-only-exports while keeping production callers on the table helpers.
export const _LOOT_BOX_GOLD_BY_TIER = LOOT_BOX_GOLD_BY_TIER;
export const _FLOOR1_COMMON_CRAFTING_MATERIALS = FLOOR1_COMMON_CRAFTING_MATERIALS;
export const _FLOOR2_CRAFTING_MATERIALS = FLOOR2_CRAFTING_MATERIALS;
export const _FLOOR2_LOOT_BOX_GOLD_BY_TIER = FLOOR2_LOOT_BOX_GOLD_BY_TIER;

/**
 * Per-tier probability that a Floor 2 achievement's loot box actually contains
 * a generated-equipment instance rather than the Floor 2 gold+materials
 * payout. Lower tiers roll a coin flip — HALF the old always-equipment rate —
 * so equipment stays a real possibility on every achievement without every
 * unlock handing out gear; `rare` (the floor's genuine milestones) still pays
 * equipment every time. The roll is deterministic per run key + achievement
 * (see `rollFloor2AchievementEquipmentDrop`), never a live RNG draw.
 */
export const FLOOR2_EQUIPMENT_DROP_CHANCE_BY_TIER: Readonly<
  Record<Floor2AchievementLootTier, number>
> = Object.freeze({
  common: 0.5,
  uncommon: 0.5,
  rare: 1,
});

/**
 * Floor 2 achievements whose equipment drop is guaranteed regardless of their
 * tier's {@link FLOOR2_EQUIPMENT_DROP_CHANCE_BY_TIER} roll. Only the one-time
 * starter kit qualifies: its entire premise (and its `details` copy) is "here
 * is your first Floor 2 equipment piece", and a player who rolled materials
 * there would start the floor with no gear path at all.
 */
export const FLOOR2_GUARANTEED_EQUIPMENT_ACHIEVEMENT_IDS: ReadonlySet<string> = new Set([
  'floor2-field-kit',
]);

/**
 * The materials payout table a `lootBox` achievement falls back to. Floor 1
 * achievements always pay `floor1-materials`; a Floor 2
 * `floor2-generated-equipment` achievement pays `floor2-materials` on a missed
 * equipment roll. Floor 2 NEVER reuses Floor 1's table — its gold and material
 * pool are its own (see {@link FLOOR2_LOOT_BOX_GOLD_BY_TIER} /
 * {@link FLOOR2_CRAFTING_MATERIALS}).
 */
export const ACHIEVEMENT_MATERIALS_TABLES = ['floor1-materials', 'floor2-materials'] as const;
export type AchievementMaterialsTable = (typeof ACHIEVEMENT_MATERIALS_TABLES)[number];

/** The exact gold a `table`/`tier` materials bundle must carry. */
export function materialsTableGoldForTier(
  table: AchievementMaterialsTable,
  tier: LootBoxTier,
): number {
  if (table === 'floor2-materials' && isFloor2AchievementLootTier(tier)) {
    return FLOOR2_LOOT_BOX_GOLD_BY_TIER[tier];
  }
  return LOOT_BOX_GOLD_BY_TIER[tier];
}

/** The exact material pool a `table` materials bundle may draw from. */
export function materialsTablePool(table: AchievementMaterialsTable): readonly string[] {
  return table === 'floor2-materials'
    ? FLOOR2_CRAFTING_MATERIALS
    : FLOOR1_COMMON_CRAFTING_MATERIALS;
}

/**
 * The materials table a given `lootBox` reward's bundle belongs to. Non-lootBox
 * rewards never resolve a materials bundle at all; they report the Floor 1
 * table so callers have a total function without a nullable branch.
 */
export function materialsTableForReward(reward: AchievementReward): AchievementMaterialsTable {
  return reward.type === 'lootBox' && reward.lootTable === 'floor2-generated-equipment'
    ? 'floor2-materials'
    : 'floor1-materials';
}

/** Schema version for {@link LootBoxRewardBundleV1}. */
export const LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION = 'lootbox-reward-bundle/v1' as const;

/**
 * A `lootBox` achievement reward's gold+materials content, resolved ONCE at
 * unlock time and persisted until claimed (mirrors the Floor 2
 * `GeneratedEquipmentRewardBundleV1` pattern: generation happens only at
 * resolution — unlock — never at claim, load, or presentation). `gold` and
 * `materials` are the exact grant a later claim will apply verbatim, with no
 * further RNG involved. Which table's gold/pool contract the bundle must
 * satisfy is derived from its achievement's own reward (see
 * {@link materialsTableForReward}) rather than stored on the bundle, so the
 * persisted v1 shape is unchanged.
 */
export interface LootBoxRewardBundleV1 {
  readonly schemaVersion: typeof LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION;
  readonly achievementId: string;
  readonly tier: LootBoxTier;
  readonly gold: number;
  readonly materials: readonly string[];
}

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
  'peakGold',
  'unlockedAbilityCount',
  'clearedFloorCount',
  'familiesAtFriendlyCount',
  'familiesAtHateCount',
  'familiesAtNeutralOrBetterCount',
  'familyBossesDefeated',
  'familyBossEncounterCount',
  'familiesEngagedInCombatCount',
] as const;
export type AchievementNumberFact = (typeof ACHIEVEMENT_NUMBER_FACTS)[number];
export const ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS = [
  'totalKills',
  'maxSkillLevel',
  'spentStatPoints',
  'completedQuestCount',
  'questLogSize',
  'playerGold',
  'peakGold',
  'unlockedAbilityCount',
  'clearedFloorCount',
] as const;
export type AchievementCurrentRunNumberFact = (typeof ACHIEVEMENT_CURRENT_RUN_NUMBER_FACTS)[number];
export const ACHIEVEMENT_BOOLEAN_FACTS = [
  'staircaseBattleStarted',
  'staircaseSpawned',
  'staircaseUnlocked',
  'safeRoomDiscovered',
  'equipmentUnlocked',
  'staircaseDiscovered',
  'runClearedFloor',
  'hasBetrayedAlly',
  'floor2SafeRoomVisited',
  'hasMetBroker',
  'allPresentFamiliesFriendly',
  'allPresentFamiliesNeutralOrBetter',
  'allPresentFamiliesEngagedInCombat',
  'allPresentFamilyBossesEngaged',
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
  | {
      /**
       * Floor 1 loot box: gold + common crafting materials, tiered by the
       * full 7-value {@link LootBoxTier} ladder. Never contains equipment —
       * structurally guaranteed by this variant having no equipment fields.
       */
      readonly type: 'lootBox';
      readonly lootTable: 'floor1-materials';
      readonly tier: LootBoxTier;
    }
  | {
      /**
       * Floor 2 generated-equipment reward, presented to the player as a
       * loot box. Resolved ONCE at unlock into an immutable, tier-scoped,
       * single-item bundle drawn from the central, catalog-derived
       * `FLOOR2_REWARD_POOL_STABLE_IDS` pool (never a per-achievement `bases`
       * array — every Floor 2 achievement shares the one frozen pool). `tier`
       * is the player-facing {@link Floor2AchievementLootTier}
       * (`common`/`uncommon`/`rare`); translate via
       * {@link FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER} before calling the
       * resolver/claim path, which still speaks the internal `tier1`-`tier3`
       * {@link EquipmentRewardTier} keyspace. `tier4` (boss chests' 85%
       * Uncommon / 15% Rare pool) is reserved exclusively for boss chests and
       * MUST NEVER appear here — see {@link Floor2AchievementLootTier}.
       */
      readonly type: 'lootBox';
      readonly lootTable: 'floor2-generated-equipment';
      readonly tier: Floor2AchievementLootTier;
    }
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

/**
 * `lootBox` reward variant, as a nested discriminated union on `lootTable`
 * (ADR 0069 amendment). Zod v4 supports nesting a discriminated union as one
 * member of an outer discriminated union — Floor 1's and Floor 2's `lootBox`
 * payloads stay structurally distinguishable (different `tier` enum, no
 * cross-table field leakage via `.strict()`) while both satisfy the single
 * outer `type: 'lootBox'` literal every other reward variant discriminates
 * against.
 */
const achievementLootBoxRewardSchema = z.discriminatedUnion('lootTable', [
  z
    .object({
      type: z.literal('lootBox'),
      lootTable: z.literal('floor1-materials'),
      tier: z.enum(LOOT_BOX_TIERS),
    })
    .strict(),
  z
    .object({
      type: z.literal('lootBox'),
      lootTable: z.literal('floor2-generated-equipment'),
      tier: z.enum(FLOOR2_ACHIEVEMENT_LOOT_TIERS),
    })
    .strict(),
]);

const achievementRewardSchema = z.discriminatedUnion('type', [
  achievementLootBoxRewardSchema,
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

/**
 * Validate that no achievement id collides with the boss-chest reward-bundle
 * keyspace (ADR 0070's adversarial plan review, concern #3 — achievements and
 * boss chests share one string-keyed reward-bundle map, so an authored
 * achievement id starting with the reserved `boss-chest:` prefix would alias
 * two independent reward sources onto one bundle entry). Throws on the first
 * violation; accepts an empty array like {@link validateCurrentRunFactCompatibility}.
 */
function validateNoReservedIdCollision(catalog: readonly AchievementDef[]): void {
  for (const achievement of catalog) {
    if (achievement.id.startsWith(BOSS_CHEST_ID_PREFIX)) {
      throw new Error(
        `Achievement id "${achievement.id}" collides with the reserved boss-chest reward-bundle prefix "${BOSS_CHEST_ID_PREFIX}"`,
      );
    }
  }
}

export function parseAchievementCatalog(rawCatalog: unknown): readonly AchievementDef[] {
  const catalog = achievementCatalogSchema.parse(rawCatalog);
  validateCurrentRunFactCompatibility(catalog);
  validateNoReservedIdCollision(catalog);
  return catalog.map(removeUnlockCriteriaDuplication);
}

export function createAchievementCatalog(
  floor: AchievementFloor,
  rawCatalog: unknown,
): AchievementCatalog {
  const parsed = possiblyEmptyAchievementCatalogSchema.parse(rawCatalog);
  validateCurrentRunFactCompatibility(parsed);
  validateNoReservedIdCollision(parsed);
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
 * Floor 2 catalog, content-driven from `data/achievements.floor2.json` (mirrors
 * the Floor 1 pattern in ADR-consistent style — a 36-entry content array lives
 * out of the schema/logic file so content diffs review separately from code
 * diffs). Contains 30 floor-scoped achievements plus 6 `current_run`-scoped
 * achievements spanning family reputation, family bosses, the settlement/Broker,
 * the exit staircase, safe rooms, equipment/ability/stat progression, and gold —
 * every criterion is driven by facts already emitted by real, shipped Floor 2
 * systems (see `collectCurrentFloorAchievementFacts` in
 * `src/game/systems/achievementSystem.ts`).
 *
 * Every achievement's reward is `{ type: 'lootBox', lootTable:
 * 'floor2-generated-equipment', tier }` (ADR 0069 amendment) — Floor 2 always
 * uses its OWN table and never Floor 1's. What a box CONTAINS is decided once,
 * at unlock, by a deterministic drop roll: `rare` boxes (and the one-time
 * `floor2-field-kit` starter kit, see
 * {@link FLOOR2_GUARANTEED_EQUIPMENT_ACHIEVEMENT_IDS}) always hold a generated
 * equipment instance, while `common`/`uncommon` boxes hold one only half the
 * time (see {@link FLOOR2_EQUIPMENT_DROP_CHANCE_BY_TIER} — half the old
 * always-equipment rate) and otherwise pay Floor 2's own richer gold +
 * crafting materials ({@link FLOOR2_LOOT_BOX_GOLD_BY_TIER} /
 * {@link FLOOR2_CRAFTING_MATERIALS}). Lower-tier achievements therefore still
 * have a real shot at gear without every unlock handing some out.
 *
 * When the roll grants equipment, it is a
 * single generated-equipment instance resolved, at unlock time, from the one
 * central, catalog-derived `FLOOR2_REWARD_POOL_STABLE_IDS` pool (see
 * `src/shared/data/floor2-reward-pool.ts`), never a per-achievement `bases`
 * array. `tier` is the player-facing {@link Floor2AchievementLootTier}
 * (`common`/`uncommon`/`rare`; 13/12/11 respectively across the 36
 * achievements, across both loot tables) — translated to the resolver's
 * internal `tier1`-`tier3`
 * {@link EquipmentRewardTier} via {@link FLOOR2_LOOT_TIER_TO_EQUIPMENT_REWARD_TIER}
 * at the claim/unlock call sites. `rare` never resolves above Rare rarity
 * (Common/Uncommon/Rare per {@link EQUIPMENT_REWARD_TIER_RARITIES}'s
 * `tier1`-`tier3` pools); Unique is intentionally never used (deferred from
 * this epic). Generated non-armor power is affix-driven: Common draws carry
 * zero non-armor bonuses (zero effect units), while Uncommon/Rare bonuses come
 * exclusively from rarity effects — the pool is not pre-filtered by base stats.
 *
 * `tier4` (boss chests' 85% Uncommon / 15% Rare pool) is reserved EXCLUSIVELY
 * for boss chests and never appears in this content — a deliberate tightening
 * from an earlier draft of this catalog, which had briefly let 3
 * `brutal`-difficulty achievements (`floor2-family-annihilator`,
 * `floor2-floor-cleared`, `floor2-scorched-earth`) share boss chests' `tier4`
 * pool. Those 3 were migrated to `rare` (the resolver's `tier3`) as part of
 * this tightening, along with promoting `floor2-safe-harbor` (a standalone,
 * non-laddered "reached the first safe room" milestone with no escalating
 * follow-up achievement to invert reward-vs-difficulty against) from `common`
 * to `rare`, to land the catalog on the required exact 13/12/11
 * common/uncommon/rare distribution. `iconId`s are placeholder keys; no art
 * is generated or required to ship this slice.
 */
export const FLOOR2_ACHIEVEMENT_CATALOG = createAchievementCatalog(2, floor2Achievements);
export const ACHIEVEMENT_CATALOG_REGISTRY = createAchievementCatalogRegistry([
  FLOOR1_ACHIEVEMENT_CATALOG,
  FLOOR2_ACHIEVEMENT_CATALOG,
]);
export const ALL_ACHIEVEMENTS: readonly AchievementDef[] = ACHIEVEMENT_CATALOG_REGISTRY.all;
export const FLOOR1_ACHIEVEMENTS: readonly AchievementDef[] = FLOOR1_ACHIEVEMENT_CATALOG.all;
export const FLOOR2_ACHIEVEMENTS: readonly AchievementDef[] = FLOOR2_ACHIEVEMENT_CATALOG.all;
/** Count of Floor 2 floor-scoped achievements (excludes `current_run`-scoped entries). */
export const FLOOR2_ACHIEVEMENT_COUNT = FLOOR2_ACHIEVEMENT_CATALOG.floorScoped.length;
/** Count of Floor 2 `current_run`-scoped (run-global) achievements. */
export const FLOOR2_RUN_GLOBAL_ACHIEVEMENT_COUNT =
  FLOOR2_ACHIEVEMENT_CATALOG.currentRunGlobal.length;

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
      peakGold: 0,
      unlockedAbilityCount: 0,
      clearedFloorCount: 0,
      familiesAtFriendlyCount: 0,
      familiesAtHateCount: 0,
      familiesAtNeutralOrBetterCount: 0,
      familyBossesDefeated: 0,
      familyBossEncounterCount: 0,
      familiesEngagedInCombatCount: 0,
    },
    booleanFacts: {
      staircaseBattleStarted: false,
      staircaseSpawned: false,
      staircaseUnlocked: false,
      safeRoomDiscovered: false,
      equipmentUnlocked: false,
      staircaseDiscovered: false,
      runClearedFloor: false,
      hasBetrayedAlly: false,
      floor2SafeRoomVisited: false,
      hasMetBroker: false,
      allPresentFamiliesFriendly: false,
      allPresentFamiliesNeutralOrBetter: false,
      allPresentFamiliesEngagedInCombat: false,
      allPresentFamilyBossesEngaged: false,
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
    // Only Floor 1's `floor1-materials` lootBox achievements need a generic
    // loot-box icon backlog entry here. Floor 2's `floor2-generated-equipment`
    // lootBox achievements are DELIBERATELY excluded: (a) their `tier` values
    // (`common`/`uncommon`/`rare`) lexically collide with 3 of Floor 1's 7
    // `LootBoxTier` values, which would silently conflate the two tables'
    // achievements into the same bucket if not filtered out here; and (b)
    // their art need is already fully covered by the separately-authored
    // `floor2-equipment-art.ts` manifest, not this generic backlog.
    if (
      achievement.reward.type !== 'lootBox' ||
      achievement.reward.lootTable !== 'floor1-materials'
    ) {
      continue;
    }
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
