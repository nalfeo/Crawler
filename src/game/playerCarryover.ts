import type { GameWorld } from '../core/world.js';
import {
  addGeneratedEquipmentToBag,
  clearEquipmentState,
  equip,
  equipFromBag,
  getEquipmentState,
  initializeBaseStats,
} from '../core/systems/equipmentSystem.js';
import { statSystem } from '../core/systems/statSystem.js';
import { SLOT_REGISTRY, type EquipmentSlotId } from '../shared/equipment-slots.js';
import { getEquipmentDefForItem } from '../shared/equipmentDefs.js';
import { ALL_STAT_IDS, PRIMARY_STATS, type PrimaryStatId, type StatId } from '../shared/stats.js';
import {
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  equipmentAbilityGrantSourceId,
  type AbilityGrantSource,
  type AbilityGrantSourceId,
  type AbilityStateLike,
} from '../shared/abilities.js';
import type { PlayerLevel, SkillState, StatModifier } from '../shared/skills.js';
import {
  ALL_ACHIEVEMENTS,
  BOSS_CHEST_ID_PREFIX,
  cloneAchievementFactSnapshot,
  getAchievementById,
  mergeAchievementFactSnapshots,
  isLootBoxTier,
  FLOOR1_COMMON_CRAFTING_MATERIALS,
  LOOT_BOX_GOLD_BY_TIER,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
  LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION,
  type AchievementFactSnapshot,
  type LootBoxRewardBundleV1,
} from '../shared/achievements.js';
import type { ResolvedRewardPresentation } from '../shared/reward-presentation.js';
import { getAbilityDefinition } from './abilities/registry.js';
import { collectCurrentFloorAchievementFacts } from './systems/achievementSystem.js';
import { normalizeAbilityState, synchronizeAbilityPassives } from './systems/abilitySystem.js';
import {
  createGeneratedEquipmentRegistry,
  listGeneratedEquipmentInstances,
  restoreGeneratedEquipmentRegistry,
  snapshotGeneratedEquipmentRegistry,
} from '../core/generated-equipment-registry.js';
import {
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  EQUIPMENT_REWARD_TIER_RARITIES,
  isEquipmentRewardTier,
  type GeneratedEquipmentInstanceId,
  type GeneratedEquipmentInstanceKey,
  type GeneratedEquipmentInstanceV1,
  type GeneratedEquipmentRegistrySnapshotV1,
  type GeneratedEquipmentRewardBundleV1,
} from '../shared/generated-equipment-types.js';
import { clearActiveWeaponDef } from '../core/active-weapon.js';
import { createBossChestId, type BossChestState } from '../core/systems/bossChestRewards.js';

const PLAYER_CARRYOVER_SCHEMA_VERSION = 'player-carryover/v1' as const;

class PlayerCarryoverSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerCarryoverSnapshotError';
  }
}

interface SkillStateSnapshot {
  readonly level: number;
  readonly usage: number;
  readonly itemBonus: number;
  readonly triggeredMilestones: readonly number[];
}

interface AbilityStateSnapshot {
  readonly learnedSpellIds: readonly string[];
  readonly equippedActiveAbilityIds: readonly string[];
  readonly passiveAbilityIds: readonly string[];
  readonly cooldownElapsedFramesByAbilityId: readonly (readonly [string, number])[];
  readonly cooldownFramesByAbilityId: readonly (readonly [string, number])[];
  readonly appliedPassiveAbilityIds?: readonly string[];
  readonly activeAbilityGrantSources?: readonly (readonly [
    string,
    readonly AbilityGrantSource[],
  ])[];
  readonly passiveAbilityGrantSources?: readonly (readonly [
    string,
    readonly AbilityGrantSource[],
  ])[];
  readonly grantOwnership?: {
    readonly schemaVersion: string;
    readonly activeSourcesByAbilityId: readonly (readonly [
      string,
      readonly AbilityGrantSourceId[],
    ])[];
    readonly passiveSourcesByAbilityId: readonly (readonly [
      string,
      readonly AbilityGrantSourceId[],
    ])[];
  };
}

interface StatModifierSnapshot extends Omit<StatModifier, 'expiresFrame'> {
  readonly expiresInFrames?: number;
}

const BOSS_CHEST_STATES: readonly BossChestState[] = [
  'available',
  'opening',
  'revealed',
  'claimed',
];

export interface BossChestCarryoverEntry {
  readonly chestId: string;
  readonly familyId: string;
  readonly state: BossChestState;
  readonly createdAtMs: number;
  /**
   * Snapshot of the reward granted on the real reveal transition, carried so a
   * reload can redisplay the reveal without re-rolling. Optional: absent on
   * chests persisted before this field existed (legacy — defaults to
   * `undefined`, never re-derived); a PRESENT-but-malformed value fails
   * closed (see the boss-chest validation loop below).
   */
  readonly revealedGrant?: ResolvedRewardPresentation;
}

export interface PlayerCarryoverSnapshot {
  readonly schemaVersion: typeof PLAYER_CARRYOVER_SCHEMA_VERSION;
  readonly sourcePlayerEid: number;
  readonly playerName: string;
  readonly playerGender: GameWorld['playerGender'];
  readonly playerLevel: Readonly<PlayerLevel>;
  readonly playerGold: number;
  readonly broadcastScore: number;
  readonly health: {
    readonly current: number;
    readonly max: number;
  };
  readonly baseStats: Readonly<Record<StatId, number>>;
  readonly coreStatPoints: Readonly<Record<PrimaryStatId, number>>;
  readonly inventorySlots: readonly {
    readonly itemId: string;
    readonly quantity: number;
  }[];
  readonly equippedItemIds: readonly string[];
  readonly generatedInventoryInstanceKeys: readonly GeneratedEquipmentInstanceKey[];
  readonly generatedEquippedInstanceKeys: readonly GeneratedEquipmentInstanceKey[];
  readonly generatedEquipmentRegistry?: GeneratedEquipmentRegistrySnapshotV1;
  readonly generatedEquipmentRewardBundles: readonly GeneratedEquipmentRewardBundleV1[];
  readonly bossChests: readonly BossChestCarryoverEntry[];
  readonly lootBoxRewardBundles: readonly LootBoxRewardBundleV1[];
  readonly disabledEquipmentSlots: readonly EquipmentSlotId[];
  readonly playerSkills: readonly (readonly [string, SkillStateSnapshot])[];
  readonly abilityState?: AbilityStateSnapshot;
  readonly persistentStatModifiers: readonly StatModifierSnapshot[];
  readonly featureUnlocks: Readonly<GameWorld['featureUnlocks']>;
  readonly achievements: {
    readonly unlockedIds: readonly string[];
    readonly pendingUnlockIds: readonly string[];
    readonly claimedIds: readonly string[];
    readonly carriedRunFacts?: AchievementFactSnapshot;
    /**
     * Resolved reward snapshots waiting to be shown/acknowledged by the
     * reward-opening presentation UI, serialized as `[achievementId,
     * presentation]` tuples (mirrors `playerSkills`'s tuple-array
     * convention for `world.achievements.pendingPresentations`, a `Map`).
     * Optional: absent on snapshots persisted before this field existed
     * (legacy — defaults to `[]`); present-but-malformed data fails closed.
     */
    readonly pendingPresentations?: readonly (readonly [string, ResolvedRewardPresentation])[];
  };
}

type LegacyPlayerCarryoverSnapshot = Omit<
  PlayerCarryoverSnapshot,
  | 'schemaVersion'
  | 'generatedInventoryInstanceKeys'
  | 'generatedEquippedInstanceKeys'
  | 'generatedEquipmentRegistry'
  | 'generatedEquipmentRewardBundles'
  | 'bossChests'
  | 'lootBoxRewardBundles'
>;

function snapshotSkillState(state: SkillState): SkillStateSnapshot {
  return {
    level: state.level,
    usage: state.usage,
    itemBonus: state.itemBonus,
    triggeredMilestones: [...state.triggeredMilestones],
  };
}

function restoreSkillState(snapshot: SkillStateSnapshot): SkillState {
  return {
    level: snapshot.level,
    usage: snapshot.usage,
    itemBonus: snapshot.itemBonus,
    triggeredMilestones: new Set(snapshot.triggeredMilestones),
  };
}

function snapshotAbilityState(
  state: AbilityStateLike | undefined,
  frameCount: number,
): AbilityStateSnapshot | undefined {
  if (!state) return undefined;
  const carriedActiveSources = (sources: readonly AbilityGrantSource[]): AbilityGrantSource[] =>
    sources.filter((source) => source.kind !== 'equipment');
  const carriedPassiveSources = (sources: readonly AbilityGrantSource[]): AbilityGrantSource[] =>
    sources.filter(
      (source) => source.kind !== 'equipment' && source.kind !== 'generated-equipment',
    );

  const activeSourceMap =
    state.activeAbilityGrantSources ?? new Map<string, AbilityGrantSource[]>();
  const passiveSourceMap =
    state.passiveAbilityGrantSources ?? new Map<string, AbilityGrantSource[]>();

  const filteredActiveSources = new Map<string, AbilityGrantSource[]>();
  for (const [abilityId, sources] of activeSourceMap) {
    const kept = carriedActiveSources(sources);
    if (kept.length > 0) filteredActiveSources.set(abilityId, kept);
  }
  const filteredPassiveSources = new Map<string, AbilityGrantSource[]>();
  for (const [abilityId, sources] of passiveSourceMap) {
    const kept = carriedPassiveSources(sources);
    if (kept.length > 0) filteredPassiveSources.set(abilityId, kept);
  }

  const normalized = normalizeAbilityState(state);

  const equippedActiveAbilityIds = state.equippedActiveAbilityIds.filter(
    (id) => filteredActiveSources.has(id) || !activeSourceMap.has(id),
  );
  const passiveAbilityIds = normalized.passiveAbilityIds.filter(
    (id) => filteredPassiveSources.has(id) || !passiveSourceMap.has(id),
  );
  const snapshotSources = (
    sourceMap: ReadonlyMap<string, ReadonlySet<AbilityGrantSourceId>>,
  ): readonly (readonly [string, readonly AbilityGrantSourceId[]])[] =>
    [...sourceMap]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([abilityId, sources]) => [abilityId, [...sources].sort()] as const);

  const snapshotLegacySources = (
    sourceMap: ReadonlyMap<string, readonly AbilityGrantSource[]>,
  ): readonly (readonly [string, readonly AbilityGrantSource[]])[] =>
    [...sourceMap]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([abilityId, sources]) => [abilityId, [...sources]] as const);

  return {
    learnedSpellIds: [...normalized.learnedSpellIds],
    equippedActiveAbilityIds,
    passiveAbilityIds,
    cooldownElapsedFramesByAbilityId: [...normalized.cooldownByAbilityId].map(
      ([abilityId, lastTriggerFrame]) =>
        [abilityId, Math.max(0, frameCount - lastTriggerFrame)] as const,
    ),
    cooldownFramesByAbilityId: [...normalized.cooldownFramesByAbilityId],
    appliedPassiveAbilityIds: [...normalized.appliedPassiveAbilityIds],
    ...(filteredActiveSources.size > 0
      ? { activeAbilityGrantSources: snapshotLegacySources(filteredActiveSources) }
      : {}),
    ...(filteredPassiveSources.size > 0
      ? { passiveAbilityGrantSources: snapshotLegacySources(filteredPassiveSources) }
      : {}),
    grantOwnership: {
      schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
      activeSourcesByAbilityId: snapshotSources(normalized.grantOwnership.activeSourcesByAbilityId),
      passiveSourcesByAbilityId: snapshotSources(
        normalized.grantOwnership.passiveSourcesByAbilityId,
      ),
    },
  };
}

function restoreAbilityState(
  snapshot: AbilityStateSnapshot,
  frameCount: number,
  persistedPassiveAbilityIds: ReadonlySet<string>,
) {
  const legacyState: AbilityStateLike = {
    learnedSpellIds: [...snapshot.learnedSpellIds],
    equippedActiveAbilityIds: [...snapshot.equippedActiveAbilityIds],
    passiveAbilityIds: [...snapshot.passiveAbilityIds],
    cooldownByAbilityId: new Map(
      snapshot.cooldownElapsedFramesByAbilityId.map(
        ([abilityId, elapsedFrames]) => [abilityId, frameCount - elapsedFrames] as const,
      ),
    ),
    cooldownFramesByAbilityId: new Map(snapshot.cooldownFramesByAbilityId),
    appliedPassiveAbilityIds: new Set(snapshot.appliedPassiveAbilityIds ?? []),
    activeAbilityGrantSources: snapshot.activeAbilityGrantSources
      ? new Map(snapshot.activeAbilityGrantSources.map(([id, sources]) => [id, [...sources]]))
      : new Map(),
    passiveAbilityGrantSources: snapshot.passiveAbilityGrantSources
      ? new Map(snapshot.passiveAbilityGrantSources.map(([id, sources]) => [id, [...sources]]))
      : new Map(),
  };
  const normalized =
    snapshot.grantOwnership === undefined
      ? normalizeAbilityState(legacyState)
      : normalizeAbilityState({
          ...legacyState,
          grantOwnership: {
            schemaVersion: snapshot.grantOwnership
              .schemaVersion as typeof ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
            activeSourcesByAbilityId: new Map(
              snapshot.grantOwnership.activeSourcesByAbilityId.map(([abilityId, sources]) => [
                abilityId,
                new Set(sources),
              ]),
            ),
            passiveSourcesByAbilityId: new Map(
              snapshot.grantOwnership.passiveSourcesByAbilityId.map(([abilityId, sources]) => [
                abilityId,
                new Set(sources),
              ]),
            ),
          },
        });
  normalized.appliedPassiveAbilityIds = new Set(
    [...normalized.appliedPassiveAbilityIds].filter(
      (abilityId) =>
        getAbilityDefinition(abilityId)?.kind === 'passive' &&
        persistedPassiveAbilityIds.has(abilityId),
    ),
  );
  normalized.equippedActiveAbilityIds = [...snapshot.equippedActiveAbilityIds];
  normalized.activeAbilityGrantSources = legacyState.activeAbilityGrantSources;
  normalized.passiveAbilityGrantSources = legacyState.passiveAbilityGrantSources;
  return normalized;
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PlayerCarryoverSnapshotError(`Expected array at ${path}`);
  }
}

function assertUniqueStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new PlayerCarryoverSnapshotError(`Expected non-empty string at ${path}`);
    }
    if (seen.has(value)) {
      throw new PlayerCarryoverSnapshotError(`Duplicate value at ${path}: ${value}`);
    }
    seen.add(value);
  }
}

/**
 * Fail-closed structural validation for a persisted
 * {@link ResolvedRewardPresentation} snapshot (used for both boss chests'
 * `revealedGrant` and achievements' `pendingPresentations` entries). Never
 * defaults/repairs a malformed value — always throws.
 */
function assertResolvedRewardPresentation(
  value: unknown,
  path: string,
): asserts value is ResolvedRewardPresentation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlayerCarryoverSnapshotError(`Expected object at ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'lootBox') {
    if (typeof record.tier !== 'string' || !isLootBoxTier(record.tier)) {
      throw new PlayerCarryoverSnapshotError(`Invalid or missing lootBox tier at ${path}.tier`);
    }
    if (typeof record.gold !== 'number' || !Number.isFinite(record.gold) || record.gold < 0) {
      throw new PlayerCarryoverSnapshotError(`Invalid lootBox gold at ${path}.gold`);
    }
    assertArray(record.materials, `${path}.materials`);
    for (const materialId of record.materials as readonly unknown[]) {
      if (typeof materialId !== 'string' || materialId.length === 0) {
        throw new PlayerCarryoverSnapshotError(`Expected non-empty string at ${path}.materials`);
      }
    }
    return;
  }
  if (record.kind === 'equipment') {
    if (typeof record.tier !== 'string' || !isEquipmentRewardTier(record.tier)) {
      throw new PlayerCarryoverSnapshotError(`Invalid or missing equipment tier at ${path}.tier`);
    }
    assertArray(record.instanceKeys, `${path}.instanceKeys`);
    for (const instanceKey of record.instanceKeys as readonly unknown[]) {
      if (typeof instanceKey !== 'string' || instanceKey.length === 0) {
        throw new PlayerCarryoverSnapshotError(`Expected non-empty string at ${path}.instanceKeys`);
      }
    }
    return;
  }
  throw new PlayerCarryoverSnapshotError(
    `Unknown reward presentation kind at ${path}: ${String(record.kind)}`,
  );
}

function normalizePlayerCarryoverSnapshot(input: unknown): PlayerCarryoverSnapshot {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PlayerCarryoverSnapshotError('Player carryover snapshot must be an object');
  }
  const record = input as Record<string, unknown>;
  if ('schemaVersion' in record && record.schemaVersion !== PLAYER_CARRYOVER_SCHEMA_VERSION) {
    throw new PlayerCarryoverSnapshotError(
      `Unsupported player carryover schema version: ${String(record.schemaVersion)}`,
    );
  }
  if (
    !('schemaVersion' in record) &&
    ('generatedEquipmentRegistry' in record ||
      'generatedInventoryInstanceKeys' in record ||
      'generatedEquippedInstanceKeys' in record ||
      'generatedEquipmentRewardBundles' in record ||
      'bossChests' in record ||
      'lootBoxRewardBundles' in record)
  ) {
    throw new PlayerCarryoverSnapshotError(
      'Unversioned player carryover cannot contain generated equipment state',
    );
  }

  const legacy = record as unknown as LegacyPlayerCarryoverSnapshot;
  // ALWAYS default the generated-equipment/lootBox/bossChest array fields when
  // absent, regardless of which schema-version branch this snapshot takes.
  // These fields were each added to the CURRENT schema version's shape after
  // that version string was first shipped (rather than via a version bump)
  // (`generatedInventoryInstanceKeys`/`generatedEquippedInstanceKeys`,
  // `generatedEquipmentRewardBundles`/`lootBoxRewardBundles` in PR #1810,
  // `bossChests` here), so a snapshot already carrying
  // `schemaVersion === PLAYER_CARRYOVER_SCHEMA_VERSION` can still legitimately
  // predate a given field. Reading `input as PlayerCarryoverSnapshot` directly
  // on that "fast path" (as a previous implementation did) would leave such a
  // field `undefined` and make `assertArray` throw, bricking the load instead
  // of gracefully treating an absent field as "none persisted". Only default
  // when the property is genuinely ABSENT — a present-but-malformed value
  // (e.g. explicit `null`) must still fall through to `assertArray` below and
  // fail closed, rather than being silently treated as "missing" (multi-model
  // code review, round 2).
  const partial = record as Partial<PlayerCarryoverSnapshot>;
  type OptionalGeneratedArrayField =
    | 'generatedInventoryInstanceKeys'
    | 'generatedEquippedInstanceKeys'
    | 'generatedEquipmentRewardBundles'
    | 'bossChests'
    | 'lootBoxRewardBundles';
  const readArrayField = (key: OptionalGeneratedArrayField): unknown[] => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return [];
    return partial[key] as unknown[];
  };

  // Migration: v1 snapshots created before `tier4` was introduced used `tier1`
  // for boss-chest reward bundles and revealedGrant entries. Upgrade them
  // transparently so existing saved Floor 2 runs continue to load correctly.
  const migrateBossChestTier = (entries: unknown[]): unknown[] => {
    if (!Array.isArray(entries)) return entries;
    return entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.revealedGrant === 'object' &&
        e.revealedGrant !== null &&
        (e.revealedGrant as Record<string, unknown>).tier === 'tier1'
      ) {
        return {
          ...e,
          revealedGrant: { ...(e.revealedGrant as object), tier: 'tier4' },
        };
      }
      return entry;
    });
  };

  const migrateBundleBossChestTier = (entries: unknown[]): unknown[] => {
    if (!Array.isArray(entries)) return entries;
    return entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const b = entry as Record<string, unknown>;
      if (
        typeof b.achievementId === 'string' &&
        b.achievementId.startsWith(BOSS_CHEST_ID_PREFIX) &&
        b.tier === 'tier1'
      ) {
        return { ...b, tier: 'tier4' };
      }
      return entry;
    });
  };

  const normalized: PlayerCarryoverSnapshot = {
    ...legacy,
    schemaVersion: PLAYER_CARRYOVER_SCHEMA_VERSION,
    generatedInventoryInstanceKeys: readArrayField(
      'generatedInventoryInstanceKeys',
    ) as PlayerCarryoverSnapshot['generatedInventoryInstanceKeys'],
    generatedEquippedInstanceKeys: readArrayField(
      'generatedEquippedInstanceKeys',
    ) as PlayerCarryoverSnapshot['generatedEquippedInstanceKeys'],
    generatedEquipmentRewardBundles: migrateBundleBossChestTier(
      readArrayField('generatedEquipmentRewardBundles'),
    ) as PlayerCarryoverSnapshot['generatedEquipmentRewardBundles'],
    bossChests: migrateBossChestTier(
      readArrayField('bossChests'),
    ) as PlayerCarryoverSnapshot['bossChests'],
    lootBoxRewardBundles: readArrayField(
      'lootBoxRewardBundles',
    ) as PlayerCarryoverSnapshot['lootBoxRewardBundles'],
  };

  assertArray(normalized.inventorySlots, 'inventorySlots');
  for (let i = 0; i < normalized.inventorySlots.length; i++) {
    const slot: unknown = normalized.inventorySlots[i];
    if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) {
      throw new PlayerCarryoverSnapshotError(`Expected object at inventorySlots[${i}]`);
    }
    const slotRecord = slot as Record<string, unknown>;
    if (typeof slotRecord.itemId !== 'string' || slotRecord.itemId.length === 0) {
      throw new PlayerCarryoverSnapshotError(
        `Expected non-empty string at inventorySlots[${i}].itemId`,
      );
    }
    if (typeof slotRecord.quantity !== 'number') {
      throw new PlayerCarryoverSnapshotError(`Expected number at inventorySlots[${i}].quantity`);
    }
  }
  assertArray(normalized.equippedItemIds, 'equippedItemIds');
  for (const itemId of normalized.equippedItemIds as readonly unknown[]) {
    if (typeof itemId !== 'string') {
      throw new PlayerCarryoverSnapshotError(`equippedItemIds must contain strings`);
    }
  }
  assertArray(normalized.generatedInventoryInstanceKeys, 'generatedInventoryInstanceKeys');
  assertArray(normalized.generatedEquippedInstanceKeys, 'generatedEquippedInstanceKeys');
  assertArray(normalized.generatedEquipmentRewardBundles, 'generatedEquipmentRewardBundles');
  assertArray(normalized.bossChests, 'bossChests');
  assertArray(normalized.lootBoxRewardBundles, 'lootBoxRewardBundles');
  assertArray(normalized.disabledEquipmentSlots, 'disabledEquipmentSlots');
  for (const slotId of normalized.disabledEquipmentSlots as readonly unknown[]) {
    if (typeof slotId !== 'string') {
      throw new PlayerCarryoverSnapshotError(`disabledEquipmentSlots must contain strings`);
    }
  }
  assertArray(normalized.playerSkills, 'playerSkills');
  for (let i = 0; i < (normalized.playerSkills as readonly unknown[]).length; i++) {
    const entry: unknown = (normalized.playerSkills as readonly unknown[])[i];
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new PlayerCarryoverSnapshotError(`Expected [id, state] tuple at playerSkills[${i}]`);
    }
  }
  assertArray(normalized.persistentStatModifiers, 'persistentStatModifiers');
  for (let i = 0; i < (normalized.persistentStatModifiers as readonly unknown[]).length; i++) {
    const entry: unknown = (normalized.persistentStatModifiers as readonly unknown[])[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PlayerCarryoverSnapshotError(`Expected object at persistentStatModifiers[${i}]`);
    }
  }
  const achievementsRaw: unknown = normalized.achievements;
  if (
    typeof achievementsRaw !== 'object' ||
    achievementsRaw === null ||
    Array.isArray(achievementsRaw)
  ) {
    throw new PlayerCarryoverSnapshotError('achievements must be a non-null object');
  }
  const ach = achievementsRaw as Record<string, unknown>;
  assertArray(ach.unlockedIds, 'achievements.unlockedIds');
  assertArray(ach.pendingUnlockIds, 'achievements.pendingUnlockIds');
  assertArray(ach.claimedIds, 'achievements.claimedIds');
  // `pendingPresentations` was added after the current schema version first
  // shipped (mirrors the `bossChests`/`lootBoxRewardBundles` "field added
  // without a version bump" convention above): only default to `[]` when the
  // property is genuinely ABSENT; a present-but-malformed value (e.g.
  // explicit `null`) must still fail closed via `assertArray` rather than
  // being silently treated as "missing".
  if (ach.pendingPresentations !== undefined) {
    assertArray(ach.pendingPresentations, 'achievements.pendingPresentations');
    for (let i = 0; i < (ach.pendingPresentations as readonly unknown[]).length; i++) {
      const entry: unknown = (ach.pendingPresentations as readonly unknown[])[i];
      const path = `achievements.pendingPresentations[${i}]`;
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new PlayerCarryoverSnapshotError(
          `Expected [achievementId, presentation] tuple at ${path}`,
        );
      }
      if (typeof entry[0] !== 'string' || entry[0].length === 0) {
        throw new PlayerCarryoverSnapshotError(`Expected non-empty string at ${path}[0]`);
      }
      assertResolvedRewardPresentation(entry[1], `${path}[1]`);
    }
  }
  const abilityStateRaw: unknown = normalized.abilityState;
  if (abilityStateRaw !== undefined) {
    if (
      typeof abilityStateRaw !== 'object' ||
      abilityStateRaw === null ||
      Array.isArray(abilityStateRaw)
    ) {
      throw new PlayerCarryoverSnapshotError('abilityState must be a non-null object');
    }
    const ast = abilityStateRaw as Record<string, unknown>;
    const validateGrantSourceEntries = (entries: unknown, field: string): void => {
      if (entries === undefined || entries === null) return;
      if (!Array.isArray(entries)) {
        throw new PlayerCarryoverSnapshotError(`Expected array at ${field}`);
      }
      for (let i = 0; i < entries.length; i++) {
        const entry: unknown = entries[i];
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
          throw new PlayerCarryoverSnapshotError(`Malformed ${field} entry at index ${i}`);
        }
        for (let j = 0; j < (entry[1] as unknown[]).length; j++) {
          const src: unknown = (entry[1] as unknown[])[j];
          if (typeof src !== 'object' || src === null) {
            throw new PlayerCarryoverSnapshotError(`Malformed ${field} source at ${i}[${j}]`);
          }
        }
      }
    };
    validateGrantSourceEntries(
      ast.activeAbilityGrantSources,
      'abilityState.activeAbilityGrantSources',
    );
    validateGrantSourceEntries(
      ast.passiveAbilityGrantSources,
      'abilityState.passiveAbilityGrantSources',
    );
  }
  return normalized;
}

interface ValidatedGeneratedCarryover {
  readonly snapshot: PlayerCarryoverSnapshot;
  readonly instancesByKey: ReadonlyMap<GeneratedEquipmentInstanceKey, GeneratedEquipmentInstanceV1>;
}

/**
 * Validates Floor 1 `lootBox` reward bundles in a carryover snapshot.
 * Independent of the generated-equipment registry machinery — lootBox
 * bundles reference no generated-equipment instances, just gold + catalog
 * material ids — so this runs unconditionally, regardless of whether a
 * registry snapshot is present in the same carryover.
 */
function validateLootBoxRewardBundles(snapshot: PlayerCarryoverSnapshot): void {
  const bundleIds = new Set<string>();
  const unlockedIds = new Set(snapshot.achievements.unlockedIds);
  const claimedIds = new Set(snapshot.achievements.claimedIds);
  for (const bundle of snapshot.lootBoxRewardBundles) {
    if (bundle.schemaVersion !== LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION) {
      throw new PlayerCarryoverSnapshotError(
        `Unsupported loot box reward bundle version: ${String(bundle.schemaVersion)}`,
      );
    }
    if (typeof bundle.achievementId !== 'string' || bundle.achievementId.length === 0) {
      throw new PlayerCarryoverSnapshotError('Loot box reward bundle requires an achievement id');
    }
    if (bundleIds.has(bundle.achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Duplicate loot box reward bundle: ${bundle.achievementId}`,
      );
    }
    bundleIds.add(bundle.achievementId);
    // Semantic guard (fail-closed): a persisted bundle may only exist for a
    // real lootBox-reward achievement that is currently unlocked but not yet
    // claimed — mirrors the equipment reward-bundle guard.
    const bundleAchievement = getAchievementById(bundle.achievementId);
    if (!bundleAchievement || bundleAchievement.reward.type !== 'lootBox') {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle for non-lootBox achievement: ${bundle.achievementId}`,
      );
    }
    if (!unlockedIds.has(bundle.achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle for locked achievement: ${bundle.achievementId}`,
      );
    }
    if (claimedIds.has(bundle.achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle persisted for already-claimed achievement: ${bundle.achievementId}`,
      );
    }
    // Tier guard (fail-closed): a resolved bundle's tier must be a real
    // LootBoxTier AND match the achievement's own defined tier (defense in
    // depth against a tampered/stale snapshot re-tiering a bundle).
    if (!isLootBoxTier(bundle.tier)) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle ${bundle.achievementId} has an invalid or missing tier`,
      );
    }
    if (bundleAchievement.reward.tier !== bundle.tier) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle ${bundle.achievementId} tier ${bundle.tier} does not match achievement tier ${bundleAchievement.reward.tier}`,
      );
    }
    if (!Number.isFinite(bundle.gold) || bundle.gold < 0) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle ${bundle.achievementId} has an invalid gold amount`,
      );
    }
    // Canonical value guard (fail-closed): gold must be EXACTLY the amount
    // the tier contract defines — not merely "any finite non-negative
    // number" — so a tampered snapshot can never inflate the gold a bundle
    // will grant on claim (e.g. forging a `trash`-tier bundle with
    // `gold: 999999`).
    if (bundle.gold !== LOOT_BOX_GOLD_BY_TIER[bundle.tier]) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle ${bundle.achievementId} has gold ${bundle.gold}, expected ${LOOT_BOX_GOLD_BY_TIER[bundle.tier]} for tier ${bundle.tier}`,
      );
    }
    // Content guard (fail-closed, structural hard gate): every material must
    // be a real Floor 1 common-crafting-material item — NEVER equipment,
    // NEVER above Common rarity — so a tampered/stale snapshot can never
    // smuggle an illegal item id into a restored bundle.
    assertArray(bundle.materials, `lootBoxRewardBundles.${bundle.achievementId}.materials`);
    for (const itemId of bundle.materials) {
      if (typeof itemId !== 'string' || !FLOOR1_COMMON_CRAFTING_MATERIALS.includes(itemId)) {
        throw new PlayerCarryoverSnapshotError(
          `Loot box reward bundle ${bundle.achievementId} has an invalid material item id: ${String(itemId)}`,
        );
      }
    }
    // Canonical value guard (fail-closed): the material COUNT must be
    // EXACTLY what the tier contract defines — not merely "any number of
    // valid material ids" — so a tampered snapshot can never inflate the
    // quantity of materials a bundle will grant on claim (e.g. forging a
    // `trash`-tier bundle with 1000 valid-but-excessive materials).
    if (bundle.materials.length !== LOOT_BOX_MATERIAL_COUNT_BY_TIER[bundle.tier]) {
      throw new PlayerCarryoverSnapshotError(
        `Loot box reward bundle ${bundle.achievementId} has ${bundle.materials.length} materials, expected ${LOOT_BOX_MATERIAL_COUNT_BY_TIER[bundle.tier]} for tier ${bundle.tier}`,
      );
    }
  }
  // Reverse guard (fail-closed): every unlocked-but-unclaimed lootBox
  // achievement in the snapshot MUST have a corresponding bundle. Without
  // this, a snapshot with a bundle stripped out (accidentally or via
  // tampering) would restore "successfully" but leave that achievement
  // permanently unclaimable (`grantFailed` forever, since bundles are only
  // ever resolved once, at unlock).
  for (const achievement of ALL_ACHIEVEMENTS) {
    if (
      achievement.reward.type === 'lootBox' &&
      unlockedIds.has(achievement.id) &&
      !claimedIds.has(achievement.id) &&
      !bundleIds.has(achievement.id)
    ) {
      throw new PlayerCarryoverSnapshotError(
        `Missing loot box reward bundle for unlocked, unclaimed achievement: ${achievement.id}`,
      );
    }
  }
}

/**
 * Semantic guard (fail-closed) for achievements' `pendingPresentations`: each
 * entry must reference an achievement that has ACTUALLY been claimed (a
 * presentation snapshot only exists after a successful claim — see
 * `claimAchievementReward` in `achievementRewards.ts`), the achievement's
 * reward type must match the persisted presentation `kind`, and the
 * persisted tier must match the achievement's own defined tier. Runs
 * unconditionally alongside the other reward-bundle guards; independent of
 * the generated-equipment registry (equipment presentations only reference
 * instance key strings, not registry entries directly).
 */
function validatePendingAchievementRewardPresentations(snapshot: PlayerCarryoverSnapshot): void {
  const claimedIds = new Set(snapshot.achievements.claimedIds);
  const seenIds = new Set<string>();
  for (const [achievementId, presentation] of snapshot.achievements.pendingPresentations ?? []) {
    if (seenIds.has(achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Duplicate pending achievement reward presentation: ${achievementId}`,
      );
    }
    seenIds.add(achievementId);
    if (!claimedIds.has(achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Pending reward presentation for un-claimed achievement: ${achievementId}`,
      );
    }
    const achievement = getAchievementById(achievementId);
    if (!achievement) {
      throw new PlayerCarryoverSnapshotError(
        `Pending reward presentation for unknown achievement: ${achievementId}`,
      );
    }
    if (achievement.reward.type !== presentation.kind) {
      throw new PlayerCarryoverSnapshotError(
        `Pending reward presentation for ${achievementId} has kind "${presentation.kind}", expected "${achievement.reward.type}"`,
      );
    }
    if (presentation.kind === 'lootBox' && achievement.reward.type === 'lootBox') {
      if (achievement.reward.tier !== presentation.tier) {
        throw new PlayerCarryoverSnapshotError(
          `Pending reward presentation for ${achievementId} has tier "${presentation.tier}", expected "${achievement.reward.tier}"`,
        );
      }
    } else if (presentation.kind === 'equipment' && achievement.reward.type === 'equipment') {
      if (achievement.reward.tier !== presentation.tier) {
        throw new PlayerCarryoverSnapshotError(
          `Pending reward presentation for ${achievementId} has tier "${presentation.tier}", expected "${achievement.reward.tier}"`,
        );
      }
    }
  }
}

/**
 * Reverse guard (fail-closed): every unlocked-but-unclaimed `equipment`
 * achievement in the snapshot MUST have a corresponding persisted reward
 * bundle. Only needs the achievements/bundle-id fields of the snapshot —
 * NOT the generated-equipment registry — so, like
 * {@link validateLootBoxRewardBundles}, it must run unconditionally,
 * regardless of whether a registry snapshot is present. Running it only
 * behind the registry-presence gate would let a snapshot with the registry
 * AND the bundle both stripped restore "successfully" while leaving the
 * achievement permanently unclaimable.
 */
function validateEquipmentBundlePresence(snapshot: PlayerCarryoverSnapshot): void {
  const unlockedIds = new Set(snapshot.achievements.unlockedIds);
  const claimedIds = new Set(snapshot.achievements.claimedIds);
  const bundleIds = new Set(
    snapshot.generatedEquipmentRewardBundles.map((bundle) => {
      // Same fail-closed rationale as the object guard in the main bundle
      // validation loop below (multi-model code review, round 4) — this
      // function runs BEFORE that loop, so it needs its own guard to avoid
      // throwing a native TypeError on a malformed (e.g. `null`) element.
      if (bundle === null || typeof bundle !== 'object') {
        throw new PlayerCarryoverSnapshotError('Generated reward bundle entry must be an object');
      }
      return bundle.achievementId;
    }),
  );
  for (const achievement of ALL_ACHIEVEMENTS) {
    if (
      achievement.reward.type === 'equipment' &&
      unlockedIds.has(achievement.id) &&
      !claimedIds.has(achievement.id) &&
      !bundleIds.has(achievement.id)
    ) {
      throw new PlayerCarryoverSnapshotError(
        `Missing generated equipment reward bundle for unlocked, unclaimed achievement: ${achievement.id}`,
      );
    }
  }
}

function validateGrantOwnership(
  abilityState: AbilityStateSnapshot | undefined,
  equippedInstances: readonly GeneratedEquipmentInstanceV1[],
): void {
  type ExpectedSource = {
    readonly abilityId: string;
    readonly kind: 'abilityGrant' | 'passiveGrant';
    readonly instanceId: GeneratedEquipmentInstanceId;
    readonly effectOrdinal: number;
  };

  const expectedSources: ExpectedSource[] = [];
  for (const instance of equippedInstances) {
    const abilityGrantIds = instance.resolvedEffects.flatMap((effect) =>
      'kind' in effect && effect.kind === 'abilityGrant' ? [effect.grantId] : [],
    );
    const passiveGrantIds = instance.resolvedEffects.flatMap((effect) =>
      'kind' in effect && effect.kind === 'passiveGrant' ? [effect.grantId] : [],
    );
    if (
      abilityGrantIds.join('\0') !== instance.frozen.abilityGrants.join('\0') ||
      passiveGrantIds.join('\0') !== instance.frozen.passiveGrants.join('\0')
    ) {
      throw new PlayerCarryoverSnapshotError(
        `Generated grant projection mismatch: ${instance.instanceId}`,
      );
    }
    for (const effect of instance.resolvedEffects) {
      if (
        !('kind' in effect) ||
        (effect.kind !== 'abilityGrant' && effect.kind !== 'passiveGrant')
      ) {
        continue;
      }
      expectedSources.push({
        abilityId: effect.grantId,
        kind: effect.kind,
        instanceId: instance.instanceId,
        effectOrdinal: effect.effectOrdinal,
      });
    }
  }

  if (expectedSources.length === 0) return;

  const toSourcesMap = (
    entries: readonly (readonly [string, readonly AbilityGrantSourceId[]])[] | undefined,
  ): Map<string, Set<AbilityGrantSourceId>> =>
    new Map(
      (entries ?? []).map((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
          throw new PlayerCarryoverSnapshotError('Malformed grant ownership source entry');
        }
        const [abilityId, sources] = entry as [string, readonly AbilityGrantSourceId[]];
        return [abilityId, new Set(sources)] as const;
      }),
    );

  const activeSourcesByAbilityId = toSourcesMap(
    abilityState?.grantOwnership?.activeSourcesByAbilityId,
  );
  const passiveSourcesByAbilityId = toSourcesMap(
    abilityState?.grantOwnership?.passiveSourcesByAbilityId,
  );
  const equippedInstancesById = new Map(
    equippedInstances.map((instance) => [instance.instanceId, instance] as const),
  );

  const validateGeneratedOwnershipSources = (
    entries: Map<string, Set<AbilityGrantSourceId>>,
    kind: 'abilityGrant' | 'passiveGrant',
  ): Set<AbilityGrantSourceId> => {
    const actualGeneratedSourceIds = new Set<AbilityGrantSourceId>();
    for (const [abilityId, sources] of entries) {
      for (const sourceId of sources) {
        if (!sourceId.startsWith('equipment:')) continue;
        const lastColon = sourceId.lastIndexOf(':');
        if (lastColon <= 'equipment:'.length) {
          throw new PlayerCarryoverSnapshotError(`Malformed generated grant source: ${sourceId}`);
        }
        const instanceId = sourceId.slice(
          'equipment:'.length,
          lastColon,
        ) as GeneratedEquipmentInstanceId;
        const ordinalText = sourceId.slice(lastColon + 1);
        const effectOrdinal = Number.parseInt(ordinalText, 10);
        if (!Number.isSafeInteger(effectOrdinal) || String(effectOrdinal) !== ordinalText) {
          throw new PlayerCarryoverSnapshotError(
            `Invalid generated grant source ordinal for ${abilityId}: ${sourceId}`,
          );
        }
        const instance = equippedInstancesById.get(instanceId);
        if (instance === undefined) {
          throw new PlayerCarryoverSnapshotError(
            `Generated grant source references unequipped or unknown instance ${instanceId}`,
          );
        }
        const matchingEffect = instance.resolvedEffects.find(
          (effect) =>
            'kind' in effect && effect.effectOrdinal === effectOrdinal && effect.kind === kind,
        );
        if (
          matchingEffect === undefined ||
          !('grantId' in matchingEffect) ||
          matchingEffect.grantId !== abilityId
        ) {
          throw new PlayerCarryoverSnapshotError(
            `Generated grant source mismatches ${abilityId}: ${sourceId}`,
          );
        }
        actualGeneratedSourceIds.add(sourceId);
      }
    }
    return actualGeneratedSourceIds;
  };

  const actualActiveGeneratedSourceIds = validateGeneratedOwnershipSources(
    activeSourcesByAbilityId,
    'abilityGrant',
  );
  const actualPassiveGeneratedSourceIds = validateGeneratedOwnershipSources(
    passiveSourcesByAbilityId,
    'passiveGrant',
  );
  const expectedActiveGeneratedSourceIds = new Set<AbilityGrantSourceId>();
  const expectedPassiveGeneratedSourceIds = new Set<AbilityGrantSourceId>();

  for (const expected of expectedSources) {
    const sourceId = equipmentAbilityGrantSourceId(expected.instanceId, expected.effectOrdinal);
    if (expected.kind === 'abilityGrant') {
      expectedActiveGeneratedSourceIds.add(sourceId);
    } else {
      expectedPassiveGeneratedSourceIds.add(sourceId);
    }
  }

  for (const expected of expectedSources) {
    const sourcesMap =
      expected.kind === 'abilityGrant' ? activeSourcesByAbilityId : passiveSourcesByAbilityId;
    const sources = sourcesMap.get(expected.abilityId) ?? new Set<AbilityGrantSourceId>();
    const expectedSourceId = equipmentAbilityGrantSourceId(
      expected.instanceId,
      expected.effectOrdinal,
    );
    if (!sources.has(expectedSourceId)) {
      throw new PlayerCarryoverSnapshotError(
        `Missing generated grant source for ${expected.abilityId} from instance ${expected.instanceId}:${expected.effectOrdinal}`,
      );
    }
  }

  for (const sourceId of actualActiveGeneratedSourceIds) {
    if (!expectedActiveGeneratedSourceIds.has(sourceId)) {
      throw new PlayerCarryoverSnapshotError(
        `Unexpected generated active grant source in carryover: ${sourceId}`,
      );
    }
  }
  for (const sourceId of actualPassiveGeneratedSourceIds) {
    if (!expectedPassiveGeneratedSourceIds.has(sourceId)) {
      throw new PlayerCarryoverSnapshotError(
        `Unexpected generated passive grant source in carryover: ${sourceId}`,
      );
    }
  }
}

function validateGeneratedCarryover(world: GameWorld, input: unknown): ValidatedGeneratedCarryover {
  const snapshot = normalizePlayerCarryoverSnapshot(input);
  // lootBox bundles reference no generated-equipment instances, so they are
  // validated unconditionally here, before the registry-presence gate below
  // (which only concerns equipment-registry-backed references).
  validateLootBoxRewardBundles(snapshot);
  // Equipment-side mirror of the lootBox reverse guard above: must also run
  // unconditionally, before the registry-presence gate, so a snapshot with
  // BOTH the registry and the bundle stripped can't slip past it (see
  // validateEquipmentBundlePresence doc comment).
  validateEquipmentBundlePresence(snapshot);
  // Also unconditional: pending reward-opening presentations reference no
  // registry state directly (only instance-key strings), so they can be
  // cross-checked against the achievements slice regardless of whether a
  // generated-equipment registry snapshot is present.
  validatePendingAchievementRewardPresentations(snapshot);
  const hasGeneratedReferences =
    snapshot.generatedInventoryInstanceKeys.length > 0 ||
    snapshot.generatedEquippedInstanceKeys.length > 0 ||
    snapshot.generatedEquipmentRewardBundles.length > 0 ||
    snapshot.bossChests.length > 0;

  if (!snapshot.generatedEquipmentRegistry) {
    if (hasGeneratedReferences) {
      throw new PlayerCarryoverSnapshotError(
        'Generated equipment references require a registry snapshot',
      );
    }
    return { snapshot, instancesByKey: new Map() };
  }

  const validationWorld = {
    generatedEquipmentRegistry: createGeneratedEquipmentRegistry({
      runKey: world.generatedEquipmentRegistry.runKey ?? undefined,
      generationPolicy: world.generatedEquipmentRegistry.generationPolicy,
    }),
  };
  restoreGeneratedEquipmentRegistry(validationWorld, snapshot.generatedEquipmentRegistry);
  const instances = listGeneratedEquipmentInstances(validationWorld);
  const instancesByKey = new Map(instances.map((instance) => [instance.instanceId, instance]));

  const owners = new Map<GeneratedEquipmentInstanceKey, string>();
  const claim = (instanceKey: GeneratedEquipmentInstanceKey, owner: string): void => {
    if (!instancesByKey.has(instanceKey)) {
      throw new PlayerCarryoverSnapshotError(
        `Dangling generated equipment reference ${instanceKey} from ${owner}`,
      );
    }
    const existing = owners.get(instanceKey);
    if (existing) {
      throw new PlayerCarryoverSnapshotError(
        `Duplicate generated equipment owner for ${instanceKey}: ${existing}, ${owner}`,
      );
    }
    owners.set(instanceKey, owner);
  };

  assertUniqueStrings(snapshot.generatedInventoryInstanceKeys, 'generatedInventoryInstanceKeys');
  assertUniqueStrings(snapshot.generatedEquippedInstanceKeys, 'generatedEquippedInstanceKeys');
  for (const key of snapshot.generatedInventoryInstanceKeys) claim(key, 'inventory');
  for (const key of snapshot.generatedEquippedInstanceKeys) claim(key, 'equipped');

  const validateFrozenAbilityGrants = (
    instance: GeneratedEquipmentInstanceV1,
    owner: string,
  ): void => {
    for (const abilityId of instance.frozen.abilityGrants) {
      const def = getAbilityDefinition(abilityId);
      if (def === undefined) {
        throw new PlayerCarryoverSnapshotError(
          `Unknown active ability grant ${abilityId} for ${instance.instanceId} (${owner})`,
        );
      }
      if (def.kind === 'passive') {
        throw new PlayerCarryoverSnapshotError(
          `Active grant ${abilityId} is passive for ${instance.instanceId} (${owner})`,
        );
      }
    }
    for (const abilityId of instance.frozen.passiveGrants) {
      const def = getAbilityDefinition(abilityId);
      if (def === undefined) {
        throw new PlayerCarryoverSnapshotError(
          `Unknown passive ability grant ${abilityId} for ${instance.instanceId} (${owner})`,
        );
      }
      if (def.kind !== 'passive') {
        throw new PlayerCarryoverSnapshotError(
          `Passive grant ${abilityId} is not passive for ${instance.instanceId} (${owner})`,
        );
      }
    }
  };

  // Boss chests share the generated-equipment reward bundle map with
  // achievements (keyed by `boss-chest:<familyId>` — see ADR 0070) instead of
  // an achievement id, so their structural validation runs first and the
  // bundle loop below branches on chest-record membership rather than
  // achievement lookups for those entries.
  const chestsByChestId = new Map<string, BossChestCarryoverEntry>();
  for (const chest of snapshot.bossChests) {
    if (chest === null || typeof chest !== 'object') {
      // `assertArray` only checks `Array.isArray`, so a malformed element
      // (e.g. `null`) would otherwise throw a native `TypeError` when we
      // access `chest.familyId` below instead of failing closed with our own
      // error type (multi-model code review, round 4).
      throw new PlayerCarryoverSnapshotError('Boss chest entry must be an object');
    }
    if (typeof chest.familyId !== 'string' || chest.familyId.length === 0) {
      // Mirrors the achievementId string guard on generatedEquipmentRewardBundles
      // below. Without this, a non-string familyId (e.g. a number) can still
      // pass the chestId-derivation check on the next line, because template
      // literal interpolation silently coerces it to a string (multi-model
      // code review, round 3).
      throw new PlayerCarryoverSnapshotError(
        `Boss chest requires a string familyId: ${String(chest.chestId)}`,
      );
    }
    if (typeof chest.createdAtMs !== 'number' || !Number.isFinite(chest.createdAtMs)) {
      throw new PlayerCarryoverSnapshotError(
        `Boss chest ${chest.chestId} has an invalid createdAtMs`,
      );
    }
    if (!BOSS_CHEST_STATES.includes(chest.state)) {
      throw new PlayerCarryoverSnapshotError(`Unknown boss chest state: ${String(chest.state)}`);
    }
    if (chest.state === 'opening') {
      // 'opening' is a transient in-transaction state that must never survive
      // a synchronous claim call; persisting it implies an interrupted
      // transaction or corruption, so fail closed rather than resume it.
      throw new PlayerCarryoverSnapshotError(
        `Boss chest persisted mid-transaction (state=opening): ${chest.chestId}`,
      );
    }
    if (chest.chestId !== createBossChestId(chest.familyId)) {
      throw new PlayerCarryoverSnapshotError(
        `Boss chest id ${chest.chestId} does not match family ${chest.familyId}`,
      );
    }
    if (chest.revealedGrant !== undefined) {
      assertResolvedRewardPresentation(
        chest.revealedGrant,
        `bossChests[${chest.chestId}].revealedGrant`,
      );
      // Boss chests only ever grant a single generated-equipment instance
      // (tier4, PLAN.md §E3-C) — never a lootBox bundle — so a persisted
      // `revealedGrant` of the wrong kind is definitely tampered/corrupt data.
      if (chest.revealedGrant.kind !== 'equipment') {
        throw new PlayerCarryoverSnapshotError(
          `Boss chest ${chest.chestId} revealedGrant must be kind "equipment", got "${chest.revealedGrant.kind}"`,
        );
      }
      if (chest.revealedGrant.tier !== 'tier4') {
        throw new PlayerCarryoverSnapshotError(
          `Boss chest ${chest.chestId} revealedGrant must have tier "tier4", got "${chest.revealedGrant.tier}"`,
        );
      }
      if (chest.revealedGrant.instanceKeys.length !== 1) {
        throw new PlayerCarryoverSnapshotError(
          `Boss chest ${chest.chestId} revealedGrant must contain exactly 1 instance, got ${chest.revealedGrant.instanceKeys.length}`,
        );
      }
      if (chest.state === 'available') {
        // `revealedGrant` is only populated on the real available->revealed
        // transition (see `openBossChest`), so a persisted `available` chest
        // carrying one is an impossible state.
        throw new PlayerCarryoverSnapshotError(
          `Boss chest ${chest.chestId} has a revealedGrant while still in state "available"`,
        );
      }
    }
    // Note: the inverse case — a 'revealed'/'claimed' chest missing its
    // `revealedGrant` (multi-model code review, round 2) — is checked further
    // below, AFTER the bundle loop. A tampered snapshot can be simultaneously
    // "revealed with no revealedGrant" AND "revealed with a lingering
    // bundle"; the bundle loop's "already-opened boss chest" check is the
    // pre-existing contract for that overlap case and must win so its error
    // message/test coverage stays stable. The missing-revealedGrant check
    // only needs to fire for the case the bundle loop can't see: no
    // revealedGrant AND no lingering bundle.
    if (chestsByChestId.has(chest.chestId)) {
      throw new PlayerCarryoverSnapshotError(`Duplicate boss chest: ${chest.chestId}`);
    }
    chestsByChestId.set(chest.chestId, chest);
  }

  const bundleIds = new Set<string>();
  const unlockedIds = new Set(snapshot.achievements.unlockedIds);
  const claimedIds = new Set(snapshot.achievements.claimedIds);
  for (const bundle of snapshot.generatedEquipmentRewardBundles) {
    if (bundle === null || typeof bundle !== 'object') {
      // Same fail-closed rationale as the boss-chest object guard above
      // (multi-model code review, round 4).
      throw new PlayerCarryoverSnapshotError('Generated reward bundle entry must be an object');
    }
    if (bundle.schemaVersion !== GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION) {
      throw new PlayerCarryoverSnapshotError(
        `Unsupported generated reward bundle version: ${String(bundle.schemaVersion)}`,
      );
    }
    if (typeof bundle.achievementId !== 'string' || bundle.achievementId.length === 0) {
      throw new PlayerCarryoverSnapshotError('Generated reward bundle requires an achievement id');
    }
    if (bundleIds.has(bundle.achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Duplicate generated reward bundle: ${bundle.achievementId}`,
      );
    }
    bundleIds.add(bundle.achievementId);
    // Tier guard (fail-closed): a resolved bundle always carries a valid tier
    // (defense in depth against a tampered/stale snapshot re-tiering a bundle).
    if (!isEquipmentRewardTier(bundle.tier)) {
      throw new PlayerCarryoverSnapshotError(
        `Reward bundle ${bundle.achievementId} has an invalid or missing tier`,
      );
    }
    const bossChest = chestsByChestId.get(bundle.achievementId);
    if (bossChest) {
      // Semantic guard (fail-closed): a persisted boss-chest bundle may only
      // exist while its chest record is still 'available' — a successful
      // openBossChest deletes the bundle the moment it grants the instances
      // to the bag, so 'revealed' and 'claimed' chests must never have a
      // lingering bundle (not just 'claimed' — see claimGeneratedEquipmentRewardBundle).
      if (bossChest.state !== 'available') {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle persisted for already-opened boss chest: ${bundle.achievementId}`,
        );
      }
      // Tier guard (fail-closed): boss-chest bundles have no backing
      // achievement to cross-check tier against, so hardcode the expected
      // tier instead — boss chests resolve at 'tier4' (85% Uncommon / 15%
      // Rare per PLAN.md §E3-C; see boss-chest-resolver.ts).
      if (bundle.tier !== 'tier4') {
        throw new PlayerCarryoverSnapshotError(
          `Boss chest reward bundle ${bundle.achievementId} has tier ${bundle.tier}, expected tier4`,
        );
      }
    } else {
      // Semantic guard (fail-closed): a persisted bundle may only exist for a real
      // equipment-reward achievement that is currently unlocked but not yet claimed.
      // A claimed bundle was consumed (its instances transferred out), so it must
      // not linger; a locked/unknown/non-equipment bundle is malformed state.
      const bundleAchievement = getAchievementById(bundle.achievementId);
      if (!bundleAchievement || bundleAchievement.reward.type !== 'equipment') {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle for non-equipment achievement: ${bundle.achievementId}`,
        );
      }
      if (!unlockedIds.has(bundle.achievementId)) {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle for locked achievement: ${bundle.achievementId}`,
        );
      }
      if (claimedIds.has(bundle.achievementId)) {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle persisted for already-claimed achievement: ${bundle.achievementId}`,
        );
      }
      // Tier guard (fail-closed): the bundle's tier must match the
      // achievement's own defined tier (defense in depth against a
      // tampered/stale snapshot re-tiering a bundle).
      if (bundleAchievement.reward.tier !== bundle.tier) {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle ${bundle.achievementId} tier ${bundle.tier} does not match achievement tier ${bundleAchievement.reward.tier}`,
        );
      }
    }
    assertArray(bundle.instanceKeys, `rewardBundles.${bundle.achievementId}.instanceKeys`);
    assertUniqueStrings(bundle.instanceKeys, `rewardBundles.${bundle.achievementId}.instanceKeys`);
    // Shape guard (fail-closed): a resolved tiered bundle ALWAYS holds exactly
    // ONE instance whose rarity is a member of that tier's allowed pool. A
    // stale or malformed snapshot with the wrong count — or an out-of-pool
    // rarity — must be rejected so it can never be restored and then "claimed"
    // as an empty/partial success that silently consumes the reward.
    if (bundle.instanceKeys.length !== 1) {
      throw new PlayerCarryoverSnapshotError(
        `Reward bundle ${bundle.achievementId} must contain exactly 1 instance, got ${bundle.instanceKeys.length}`,
      );
    }
    const allowedRarities = EQUIPMENT_REWARD_TIER_RARITIES[bundle.tier];
    bundle.instanceKeys.forEach((key) => {
      claim(key, `reward-bundle:${bundle.achievementId}`);
      const instance = instancesByKey.get(key)!;
      if (!allowedRarities.includes(instance.rarity)) {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle ${bundle.achievementId} instance has rarity ${instance.rarity}, expected one of [${allowedRarities.join(', ')}] for tier ${bundle.tier}`,
        );
      }
    });
  }
  // Note: the reverse "every unlocked-unclaimed equipment achievement has a
  // bundle" check now runs unconditionally near the top of this function via
  // validateEquipmentBundlePresence(snapshot) — see its doc comment for why
  // it can't live down here (this whole branch is skipped when the registry
  // snapshot is absent).

  // Bidirectional consistency (fail-closed): an 'available' boss chest must
  // still have its live reward bundle (it hasn't been generated-and-lost),
  // while 'revealed'/'claimed' chests must not — the branch above already
  // rejects a lingering bundle for either of those states, so only the
  // forward direction (available ⇒ has bundle) needs checking here.
  for (const chest of chestsByChestId.values()) {
    if (chest.state === 'available' && !bundleIds.has(chest.chestId)) {
      throw new PlayerCarryoverSnapshotError(
        `Boss chest ${chest.chestId} is missing its reward bundle`,
      );
    }
    // `revealedGrant` is populated on the same transition that sets state to
    // 'revealed' (see `openBossChest`) and is never cleared on the
    // revealed->claimed transition (see `acknowledgeBossChestReveal`), so a
    // persisted 'revealed'/'claimed' chest missing it is impossible from real
    // gameplay — fail closed rather than resume/present it (multi-model code
    // review, round 2). Checked here (after the bundle loop above) so that a
    // snapshot which is ALSO carrying a lingering bundle for this chest hits
    // the pre-existing "already-opened boss chest" bundle-check first.
    if ((chest.state === 'revealed' || chest.state === 'claimed') && !chest.revealedGrant) {
      throw new PlayerCarryoverSnapshotError(
        `Boss chest ${chest.chestId} is in state "${chest.state}" but has no revealedGrant`,
      );
    }
    if (chest.revealedGrant?.kind === 'equipment') {
      for (const key of chest.revealedGrant.instanceKeys) {
        if (!instancesByKey.has(key)) {
          throw new PlayerCarryoverSnapshotError(
            `Boss chest ${chest.chestId} revealedGrant has dangling instance key: ${key}`,
          );
        }
      }
    }
  }

  const occupiedSlots = new Map<EquipmentSlotId, string>();
  for (const itemId of snapshot.equippedItemIds) {
    const def = getEquipmentDefForItem(itemId);
    if (!def) {
      throw new PlayerCarryoverSnapshotError(
        `Unknown equipped item in player carryover: ${itemId}`,
      );
    }
    for (const slotId of def.slots) {
      const existing = occupiedSlots.get(slotId);
      if (existing) {
        throw new PlayerCarryoverSnapshotError(
          `Duplicate equipped slot ${slotId}: ${existing}, ${itemId}`,
        );
      }
      occupiedSlots.set(slotId, itemId);
    }
  }

  const equippedInstances = snapshot.generatedEquippedInstanceKeys.map((key) => {
    const instance = instancesByKey.get(key);
    if (!instance) {
      throw new PlayerCarryoverSnapshotError(`Dangling generated equipped reference: ${key}`);
    }
    for (const slotId of instance.frozen.slots) {
      const existing = occupiedSlots.get(slotId);
      if (existing) {
        throw new PlayerCarryoverSnapshotError(
          `Duplicate equipped slot ${slotId}: ${existing}, ${key}`,
        );
      }
      occupiedSlots.set(slotId, key);
    }
    return instance;
  });

  if (
    equippedInstances.filter((instance) => instance.frozen.activeWeaponSnapshot !== null).length > 1
  ) {
    throw new PlayerCarryoverSnapshotError(
      'Multiple generated active weapon snapshots are equipped',
    );
  }

  for (const [instanceKey, owner] of owners) {
    const instance = instancesByKey.get(instanceKey);
    if (!instance) continue;
    validateFrozenAbilityGrants(instance, owner);
  }

  const assertNoSerializedEquipmentGrantSources = (
    grantSources: readonly (readonly [string, readonly AbilityGrantSource[]])[] | undefined,
    field: 'activeAbilityGrantSources' | 'passiveAbilityGrantSources',
    allowGeneratedEquipment: boolean,
  ): void => {
    if (!grantSources) return;
    for (const entry of grantSources as readonly unknown[]) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
        throw new PlayerCarryoverSnapshotError(`Malformed ${field} entry`);
      }
      const abilityId = entry[0] as string;
      const sources = entry[1] as readonly unknown[];
      for (const source of sources) {
        if (typeof source !== 'object' || source === null) {
          throw new PlayerCarryoverSnapshotError(`Malformed ${field} source for ${abilityId}`);
        }
        const typedSource = source as AbilityGrantSource;
        if (
          typedSource.kind === 'equipment' ||
          (typedSource.kind === 'generated-equipment' && !allowGeneratedEquipment)
        ) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot ${field} must not contain equipment source for ${abilityId}`,
          );
        }
      }
    }
  };
  const validateGeneratedActiveGrantSources = (
    grantSources: readonly (readonly [string, readonly AbilityGrantSource[]])[] | undefined,
  ): void => {
    if (!grantSources) return;
    const equippedInstanceKeys = new Set(snapshot.generatedEquippedInstanceKeys);
    const seenGeneratedSources = new Set<string>();
    for (const entry of grantSources as readonly unknown[]) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
        throw new PlayerCarryoverSnapshotError('Malformed activeAbilityGrantSources entry');
      }
      const abilityId = entry[0] as string;
      const sources = entry[1] as readonly unknown[];
      for (const source of sources) {
        if (typeof source !== 'object' || source === null) {
          throw new PlayerCarryoverSnapshotError(
            `Malformed activeAbilityGrantSources source for ${abilityId}`,
          );
        }
        const typedSource = source as AbilityGrantSource;
        if (typedSource.kind !== 'generated-equipment') continue;
        if (!equippedInstanceKeys.has(typedSource.instanceId)) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has unequipped generated source for ${abilityId}: ${typedSource.instanceId}`,
          );
        }
        const instance = instancesByKey.get(typedSource.instanceId);
        if (!instance) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has unknown generated source for ${abilityId}: ${typedSource.instanceId}`,
          );
        }
        if (!Number.isInteger(typedSource.effectOrdinal) || typedSource.effectOrdinal < 0) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has invalid generated source ordinal for ${abilityId}: ${String(typedSource.effectOrdinal)}`,
          );
        }
        const sourceKey = `${typedSource.instanceId}:${typedSource.effectOrdinal}`;
        if (seenGeneratedSources.has(sourceKey)) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has duplicate generated source for ${abilityId}: ${sourceKey}`,
          );
        }
        seenGeneratedSources.add(sourceKey);
        if (instance.frozen.abilityGrants[typedSource.effectOrdinal] !== abilityId) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources mismatches generated source for ${abilityId}: ${sourceKey}`,
          );
        }
      }
    }
  };
  assertNoSerializedEquipmentGrantSources(
    snapshot.abilityState?.activeAbilityGrantSources,
    'activeAbilityGrantSources',
    true,
  );
  validateGeneratedActiveGrantSources(snapshot.abilityState?.activeAbilityGrantSources);
  assertNoSerializedEquipmentGrantSources(
    snapshot.abilityState?.passiveAbilityGrantSources,
    'passiveAbilityGrantSources',
    false,
  );
  validateGrantOwnership(snapshot.abilityState, equippedInstances);

  return { snapshot, instancesByKey };
}

function getModifierHolderIndex(modifier: StatModifierSnapshot): number | undefined {
  const parts = modifier.sourceId.split(':');
  if (
    modifier.sourceType === 'ability' &&
    (parts[1] === 'active' || parts[1] === 'passive') &&
    parts.length >= 3
  ) {
    return 2;
  }
  if (
    modifier.sourceType === 'skill' &&
    (parts[1] === 'level' || parts[1] === 'milestone') &&
    parts.length >= 4
  ) {
    return 3;
  }
  return undefined;
}

function modifierBelongsToPlayer(modifier: StatModifierSnapshot, playerEid: number): boolean {
  const holderIndex = getModifierHolderIndex(modifier);
  if (holderIndex === undefined) {
    return modifier.sourceType === 'skill';
  }
  return Number(modifier.sourceId.split(':')[holderIndex]) === playerEid;
}

function parseAbilityModifierSource(
  sourceId: string,
): { readonly abilityId: string; readonly kind: 'active' | 'passive' } | undefined {
  const parts = sourceId.split(':');
  if (parts.length < 3) return undefined;
  if (parts[1] !== 'active' && parts[1] !== 'passive') return undefined;
  return { abilityId: parts[0] ?? '', kind: parts[1] };
}

function isPassiveAbilityModifier(modifier: StatModifierSnapshot): boolean {
  return modifier.sourceType === 'ability' && modifier.sourceId.split(':')[1] === 'passive';
}

function isCatalogBackedAbilityModifier(modifier: StatModifierSnapshot): boolean {
  if (modifier.sourceType !== 'ability') return true;
  const abilityId = modifier.sourceId.split(':')[0];
  if (!abilityId) return true;
  return getAbilityDefinition(abilityId) !== undefined;
}

function remapModifierHolder(
  modifier: StatModifierSnapshot,
  sourcePlayerEid: number,
  playerEid: number,
): string {
  const holderIndex = getModifierHolderIndex(modifier);
  if (holderIndex === undefined) return modifier.sourceId;

  const parts = modifier.sourceId.split(':');
  if (Number(parts[holderIndex]) !== sourcePlayerEid) return modifier.sourceId;
  parts[holderIndex] = String(playerEid);
  return parts.join(':');
}

export function capturePlayerCarryover(
  world: GameWorld,
  playerEid: number,
): PlayerCarryoverSnapshot {
  const baseStats = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    baseStats[statId] = world.stores.baseStats[statId][playerEid] ?? 0;
  }

  const coreStatPoints = {} as Record<PrimaryStatId, number>;
  for (const statId of PRIMARY_STATS) {
    coreStatPoints[statId] = world.stores.coreStatPoints[statId][playerEid] ?? 0;
  }

  const equipment = getEquipmentState(world, playerEid);
  const equippedItemIds: string[] = [];
  const generatedEquippedInstanceKeys: GeneratedEquipmentInstanceKey[] = [];
  const seenStaticInstances = new Set<number>();
  const seenGeneratedInstances = new Set<GeneratedEquipmentInstanceKey>();

  if (equipment) {
    for (const slot of SLOT_REGISTRY) {
      const instanceId = equipment.equipped[slot.id];
      if (instanceId == null) continue;
      if (typeof instanceId !== 'number') {
        if (!seenGeneratedInstances.has(instanceId)) {
          seenGeneratedInstances.add(instanceId);
          generatedEquippedInstanceKeys.push(instanceId);
        }
        continue;
      }
      if (seenStaticInstances.has(instanceId)) continue;
      const instance = equipment.instances.get(instanceId);
      if (!instance) {
        throw new Error(`Missing equipped instance ${instanceId} while capturing player carryover`);
      }
      seenStaticInstances.add(instanceId);
      equippedItemIds.push(instance.def.id);
    }
  }

  const inventory = world.inventories.get(playerEid);
  const abilityState = snapshotAbilityState(
    world.abilityStatesByEntity.get(playerEid),
    world.frameCount,
  );
  const carriedActiveAbilityIds = new Set(abilityState?.equippedActiveAbilityIds ?? []);
  const carriedPassiveAbilityIds = new Set(abilityState?.passiveAbilityIds ?? []);
  const carriedAppliedPassiveAbilityIds = new Set(abilityState?.appliedPassiveAbilityIds ?? []);
  const generatedEquipmentRegistry =
    world.generatedEquipmentRegistry.runKey === null
      ? undefined
      : snapshotGeneratedEquipmentRegistry(world);

  const snapshot: PlayerCarryoverSnapshot = {
    schemaVersion: PLAYER_CARRYOVER_SCHEMA_VERSION,
    sourcePlayerEid: playerEid,
    playerName: world.playerName,
    playerGender: world.playerGender,
    playerLevel: { ...world.playerLevel },
    playerGold: world.playerGold,
    broadcastScore: world.stores.broadcastScore.current[playerEid] ?? 0,
    health: {
      current: world.stores.health.current[playerEid] ?? 0,
      max: world.stores.health.max[playerEid] ?? 0,
    },
    baseStats,
    coreStatPoints,
    inventorySlots: inventory?.slots.map((slot) => ({ ...slot })) ?? [],
    equippedItemIds,
    generatedInventoryInstanceKeys:
      inventory?.generatedEquipment?.map((entry) => entry.instanceKey) ?? [],
    generatedEquippedInstanceKeys,
    ...(generatedEquipmentRegistry ? { generatedEquipmentRegistry } : {}),
    generatedEquipmentRewardBundles: [...world.generatedEquipmentRewardBundles.values()].map(
      (bundle) => ({
        schemaVersion: bundle.schemaVersion,
        achievementId: bundle.achievementId,
        tier: bundle.tier,
        instanceKeys: [...bundle.instanceKeys],
      }),
    ),
    bossChests: [...world.bossChests.values()].map((chest) => ({
      chestId: chest.chestId,
      familyId: chest.familyId,
      state: chest.state,
      createdAtMs: chest.createdAtMs,
      ...(chest.revealedGrant ? { revealedGrant: chest.revealedGrant } : {}),
    })),
    lootBoxRewardBundles: [...world.lootBoxRewardBundles.values()].map((bundle) => ({
      schemaVersion: bundle.schemaVersion,
      achievementId: bundle.achievementId,
      tier: bundle.tier,
      gold: bundle.gold,
      materials: [...bundle.materials],
    })),
    disabledEquipmentSlots: equipment ? [...equipment.disabledSlots] : [],
    playerSkills: [...world.playerSkills].map(([id, state]) => [id, snapshotSkillState(state)]),
    ...(abilityState ? { abilityState } : {}),
    persistentStatModifiers: world.statModifiers
      .filter(
        (modifier) =>
          (modifier.sourceType === 'skill' || modifier.sourceType === 'ability') &&
          !isPassiveAbilityModifier(modifier) &&
          (modifier.expiresFrame === undefined || modifier.expiresFrame > world.frameCount) &&
          modifierBelongsToPlayer(modifier, playerEid) &&
          (modifier.sourceType !== 'ability' ||
            (() => {
              const parsed = parseAbilityModifierSource(modifier.sourceId);
              if (!parsed) return false;
              if (parsed.kind === 'active') {
                return carriedActiveAbilityIds.has(parsed.abilityId);
              }
              return (
                carriedPassiveAbilityIds.has(parsed.abilityId) &&
                carriedAppliedPassiveAbilityIds.has(parsed.abilityId)
              );
            })()),
      )
      .map(({ expiresFrame, ...modifier }) => ({
        ...modifier,
        ...(expiresFrame === undefined ? {} : { expiresInFrames: expiresFrame - world.frameCount }),
      })),
    featureUnlocks: { ...world.featureUnlocks },
    achievements: {
      unlockedIds: [...world.achievements.unlockedIds],
      pendingUnlockIds: [...world.achievements.pendingUnlockIds],
      claimedIds: [...world.achievements.claimedIds],
      carriedRunFacts: mergeAchievementFactSnapshots(
        world.achievements.carriedRunFacts,
        collectCurrentFloorAchievementFacts(world),
      ),
      pendingPresentations: [...world.achievements.pendingPresentations.entries()],
    },
  };

  validateGeneratedCarryover(world, snapshot);
  return snapshot;
}

export function restorePlayerCarryover(world: GameWorld, playerEid: number, input: unknown): void {
  const { snapshot } = validateGeneratedCarryover(world, input);

  world.playerName = snapshot.playerName;
  world.playerGender = snapshot.playerGender;
  world.playerLevel = { ...snapshot.playerLevel };
  world.playerGold = snapshot.playerGold;
  world.featureUnlocks = {
    inventory: world.featureUnlocks.inventory || snapshot.featureUnlocks.inventory,
    equipment: world.featureUnlocks.equipment || snapshot.featureUnlocks.equipment,
    spells: world.featureUnlocks.spells || snapshot.featureUnlocks.spells,
  };
  world.achievements = {
    unlockedIds: new Set(snapshot.achievements.unlockedIds),
    pendingUnlockIds: [...snapshot.achievements.pendingUnlockIds],
    claimedIds: new Set(snapshot.achievements.claimedIds),
    carriedRunFacts: cloneAchievementFactSnapshot(snapshot.achievements.carriedRunFacts),
    pendingPresentations: new Map(snapshot.achievements.pendingPresentations ?? []),
  };

  clearEquipmentState(world, playerEid);
  clearActiveWeaponDef(world);
  initializeBaseStats(world, playerEid, snapshot.baseStats);
  for (const statId of PRIMARY_STATS) {
    world.stores.coreStatPoints[statId][playerEid] = snapshot.coreStatPoints[statId];
  }

  const floorModifiers = world.statModifiers.filter((modifier) => modifier.sourceType === 'floor');
  world.statModifiers = [
    ...floorModifiers,
    ...snapshot.persistentStatModifiers
      .filter(isCatalogBackedAbilityModifier)
      .map(({ expiresInFrames, ...modifier }) => ({
        ...modifier,
        sourceId: remapModifierHolder(modifier, snapshot.sourcePlayerEid, playerEid),
        ...(expiresInFrames === undefined
          ? {}
          : { expiresFrame: world.frameCount + expiresInFrames }),
      })),
  ];

  world.inventories.set(playerEid, {
    slots: snapshot.inventorySlots.map((slot) => ({ ...slot })),
  });
  const restoredSkills = new Map(
    snapshot.playerSkills.map(([id, state]) => [id, restoreSkillState(state)]),
  );
  world.playerSkills = restoredSkills;
  world.skillStatesByEntity.set(playerEid, new Map(restoredSkills));
  if (snapshot.abilityState) {
    const persistedPassiveAbilityIds = new Set(
      snapshot.persistentStatModifiers
        .filter(isPassiveAbilityModifier)
        .map((modifier) => parseAbilityModifierSource(modifier.sourceId)?.abilityId)
        .filter(
          (abilityId): abilityId is string => abilityId !== undefined && abilityId.length > 0,
        ),
    );
    world.abilityStatesByEntity.set(
      playerEid,
      restoreAbilityState(snapshot.abilityState, world.frameCount, persistedPassiveAbilityIds),
    );
    synchronizeAbilityPassives(world, playerEid);
  } else {
    world.abilityStatesByEntity.delete(playerEid);
  }

  if (snapshot.generatedEquipmentRegistry) {
    restoreGeneratedEquipmentRegistry(world, snapshot.generatedEquipmentRegistry);
  }
  // Rebuild the reward-bundle map immediately after the registry restore and
  // BEFORE any bag/equipped restore. Bundles are registry owners, so having them
  // in place first keeps the single-owner invariant enforceable while bag and
  // equipped instances are re-added.
  world.generatedEquipmentRewardBundles = new Map(
    snapshot.generatedEquipmentRewardBundles.map((bundle) => [
      bundle.achievementId,
      Object.freeze({
        schemaVersion: bundle.schemaVersion,
        achievementId: bundle.achievementId,
        tier: bundle.tier,
        instanceKeys: Object.freeze([...bundle.instanceKeys]),
      }),
    ]),
  );
  // Rebuild boss chest lifecycle records after the bundle map so any
  // non-claimed chest's bundle is already present, keeping the pair
  // consistent for the very next openBossChest call.
  world.bossChests = new Map(
    snapshot.bossChests.map((chest) => [
      chest.chestId,
      {
        chestId: chest.chestId,
        familyId: chest.familyId,
        state: chest.state,
        createdAtMs: chest.createdAtMs,
        ...(chest.revealedGrant ? { revealedGrant: chest.revealedGrant } : {}),
      },
    ]),
  );
  // lootBox bundles reference no generated-equipment instances, so they can
  // be restored independently of the registry restore above.
  world.lootBoxRewardBundles = new Map(
    snapshot.lootBoxRewardBundles.map((bundle) => [
      bundle.achievementId,
      Object.freeze({
        schemaVersion: bundle.schemaVersion,
        achievementId: bundle.achievementId,
        tier: bundle.tier,
        gold: bundle.gold,
        materials: Object.freeze([...bundle.materials]),
      }),
    ]),
  );

  for (const itemId of snapshot.equippedItemIds) {
    const itemDef = getEquipmentDefForItem(itemId);
    if (!itemDef) {
      throw new Error(`Unknown equipped item in player carryover: ${itemId}`);
    }
    const result = equip(world, playerEid, itemDef, { force: true });
    if (!result.ok) {
      throw new Error(
        `Failed to restore equipped item ${itemId}: ${result.reasons
          .map((reason) => reason.type)
          .join('; ')}`,
      );
    }
  }

  for (const instanceKey of snapshot.generatedInventoryInstanceKeys) {
    const result = addGeneratedEquipmentToBag(world, playerEid, instanceKey);
    if (!result.ok) {
      throw new PlayerCarryoverSnapshotError(
        `Failed to restore generated inventory ${instanceKey}: ${result.reason.type}`,
      );
    }
  }
  for (const instanceKey of snapshot.generatedEquippedInstanceKeys) {
    const added = addGeneratedEquipmentToBag(world, playerEid, instanceKey);
    if (!added.ok) {
      throw new PlayerCarryoverSnapshotError(
        `Failed to stage generated equipment ${instanceKey}: ${added.reason.type}`,
      );
    }
    const equipped = equipFromBag(world, playerEid, added.entry, { force: true });
    if (!equipped.ok) {
      throw new PlayerCarryoverSnapshotError(
        `Failed to restore generated equipment ${instanceKey}: ${equipped.reasons
          .map((reason) => reason.type)
          .join('; ')}`,
      );
    }
  }

  const equipment = getEquipmentState(world, playerEid);
  if (!equipment) {
    throw new Error('Equipment state missing after player carryover restore');
  }
  for (const slotId of snapshot.disabledEquipmentSlots) {
    equipment.disabledSlots.add(slotId);
  }

  statSystem(world);
  world.stores.health.current[playerEid] = snapshot.health.current;
  world.stores.health.max[playerEid] = snapshot.health.max;
  world.stores.broadcastScore.current[playerEid] = snapshot.broadcastScore;
}
