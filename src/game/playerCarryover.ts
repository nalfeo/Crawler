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
  cloneAchievementFactSnapshot,
  getAchievementById,
  mergeAchievementFactSnapshots,
  type AchievementFactSnapshot,
} from '../shared/achievements.js';
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
  GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES,
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
      'bossChests' in record)
  ) {
    throw new PlayerCarryoverSnapshotError(
      'Unversioned player carryover cannot contain generated equipment state',
    );
  }

  const legacy = record as unknown as LegacyPlayerCarryoverSnapshot;
  const normalized: PlayerCarryoverSnapshot =
    record.schemaVersion === PLAYER_CARRYOVER_SCHEMA_VERSION
      ? {
          ...(input as PlayerCarryoverSnapshot),
          // `bossChests` was added to the "player-carryover/v1" shape without a
          // schema-version bump (mirroring how `generatedEquipmentRewardBundles`
          // was added in PR #1810), so a snapshot serialized before this field
          // existed still matches this "current schema" branch but omits it.
          // Default rather than hard-failing carryover restore for pre-existing
          // saves (multi-model code review, round 1).
          bossChests: (record as Partial<PlayerCarryoverSnapshot>).bossChests ?? [],
        }
      : ({
          ...legacy,
          schemaVersion: PLAYER_CARRYOVER_SCHEMA_VERSION,
          generatedInventoryInstanceKeys: [],
          generatedEquippedInstanceKeys: [],
          generatedEquipmentRewardBundles: [],
          bossChests: [],
        } satisfies PlayerCarryoverSnapshot);

  assertArray(normalized.inventorySlots, 'inventorySlots');
  assertArray(normalized.equippedItemIds, 'equippedItemIds');
  assertArray(normalized.generatedInventoryInstanceKeys, 'generatedInventoryInstanceKeys');
  assertArray(normalized.generatedEquippedInstanceKeys, 'generatedEquippedInstanceKeys');
  assertArray(normalized.generatedEquipmentRewardBundles, 'generatedEquipmentRewardBundles');
  assertArray(normalized.bossChests, 'bossChests');
  assertArray(normalized.disabledEquipmentSlots, 'disabledEquipmentSlots');
  return normalized;
}

interface ValidatedGeneratedCarryover {
  readonly snapshot: PlayerCarryoverSnapshot;
  readonly instancesByKey: ReadonlyMap<GeneratedEquipmentInstanceKey, GeneratedEquipmentInstanceV1>;
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
    new Map((entries ?? []).map(([abilityId, sources]) => [abilityId, new Set(sources)]));

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
    if (chestsByChestId.has(chest.chestId)) {
      throw new PlayerCarryoverSnapshotError(`Duplicate boss chest: ${chest.chestId}`);
    }
    chestsByChestId.set(chest.chestId, chest);
  }

  const bundleIds = new Set<string>();
  const unlockedIds = new Set(snapshot.achievements.unlockedIds);
  const claimedIds = new Set(snapshot.achievements.claimedIds);
  for (const bundle of snapshot.generatedEquipmentRewardBundles) {
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
    }
    assertArray(bundle.instanceKeys, `rewardBundles.${bundle.achievementId}.instanceKeys`);
    assertUniqueStrings(bundle.instanceKeys, `rewardBundles.${bundle.achievementId}.instanceKeys`);
    // Shape guard (fail-closed): a resolved bundle ALWAYS holds exactly one
    // Common, one Uncommon, one Rare instance in that canonical order. A stale or
    // malformed snapshot with the wrong count — or the wrong per-index rarity —
    // must be rejected so it can never be restored and then "claimed" as an
    // empty/partial success that silently consumes the reward.
    if (bundle.instanceKeys.length !== GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES.length) {
      throw new PlayerCarryoverSnapshotError(
        `Reward bundle ${bundle.achievementId} must contain exactly ${GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES.length} instances, got ${bundle.instanceKeys.length}`,
      );
    }
    bundle.instanceKeys.forEach((key, index) => {
      claim(key, `reward-bundle:${bundle.achievementId}`);
      const instance = instancesByKey.get(key)!;
      const expectedRarity = GENERATED_EQUIPMENT_REWARD_BUNDLE_RARITIES[index]!;
      if (instance.rarity !== expectedRarity) {
        throw new PlayerCarryoverSnapshotError(
          `Reward bundle ${bundle.achievementId} instance ${index} has rarity ${instance.rarity}, expected ${expectedRarity}`,
        );
      }
    });
  }

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
    for (const [abilityId, sources] of grantSources) {
      for (const source of sources) {
        if (
          source.kind === 'equipment' ||
          (source.kind === 'generated-equipment' && !allowGeneratedEquipment)
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
    for (const [abilityId, sources] of grantSources) {
      for (const source of sources) {
        if (source.kind !== 'generated-equipment') continue;
        if (!equippedInstanceKeys.has(source.instanceId)) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has unequipped generated source for ${abilityId}: ${source.instanceId}`,
          );
        }
        const instance = instancesByKey.get(source.instanceId);
        if (!instance) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has unknown generated source for ${abilityId}: ${source.instanceId}`,
          );
        }
        if (!Number.isInteger(source.effectOrdinal) || source.effectOrdinal < 0) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has invalid generated source ordinal for ${abilityId}: ${String(source.effectOrdinal)}`,
          );
        }
        const sourceKey = `${source.instanceId}:${source.effectOrdinal}`;
        if (seenGeneratedSources.has(sourceKey)) {
          throw new PlayerCarryoverSnapshotError(
            `Snapshot activeAbilityGrantSources has duplicate generated source for ${abilityId}: ${sourceKey}`,
          );
        }
        seenGeneratedSources.add(sourceKey);
        if (instance.frozen.abilityGrants[source.effectOrdinal] !== abilityId) {
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
        instanceKeys: [...bundle.instanceKeys],
      }),
    ),
    bossChests: [...world.bossChests.values()].map((chest) => ({
      chestId: chest.chestId,
      familyId: chest.familyId,
      state: chest.state,
      createdAtMs: chest.createdAtMs,
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
      },
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
