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
  type AbilityGrantSourceId,
  type AbilityStateLike,
} from '../shared/abilities.js';
import type { PlayerLevel, SkillState, StatModifier } from '../shared/skills.js';
import {
  cloneAchievementFactSnapshot,
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
  type GeneratedEquipmentInstanceId,
  type GeneratedEquipmentInstanceKey,
  type GeneratedEquipmentInstanceV1,
  type GeneratedEquipmentRegistrySnapshotV1,
  type GeneratedEquipmentRewardBundleV1,
} from '../shared/generated-equipment-types.js';
import { clearActiveWeaponDef } from '../core/active-weapon.js';

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
  readonly disabledEquipmentSlots: readonly EquipmentSlotId[];
  readonly playerSkills: readonly (readonly [string, SkillStateSnapshot])[];
  readonly abilityState?: AbilityStateSnapshot;
  readonly persistentStatModifiers: readonly StatModifierSnapshot[];
  readonly featureUnlocks: Readonly<GameWorld['featureUnlocks']>;
  readonly achievements: {
    readonly unlockedIds: readonly string[];
    readonly pendingUnlockIds: readonly string[];
    readonly claimedIds: readonly string[];
    /** Optional for backward compatibility with pre-scoped carryover snapshots. */
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
  const normalized = normalizeAbilityState(state);
  const snapshotSources = (
    sourceMap: ReadonlyMap<string, ReadonlySet<AbilityGrantSourceId>>,
  ): readonly (readonly [string, readonly AbilityGrantSourceId[]])[] =>
    [...sourceMap]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([abilityId, sources]) => [abilityId, [...sources].sort()] as const);
  return {
    learnedSpellIds: [...normalized.learnedSpellIds],
    equippedActiveAbilityIds: [...normalized.equippedActiveAbilityIds],
    passiveAbilityIds: [...normalized.passiveAbilityIds],
    cooldownElapsedFramesByAbilityId: [...normalized.cooldownByAbilityId].map(
      ([abilityId, lastTriggerFrame]) =>
        [abilityId, Math.max(0, frameCount - lastTriggerFrame)] as const,
    ),
    cooldownFramesByAbilityId: [...normalized.cooldownFramesByAbilityId],
    grantOwnership: {
      schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
      activeSourcesByAbilityId: snapshotSources(normalized.grantOwnership.activeSourcesByAbilityId),
      passiveSourcesByAbilityId: snapshotSources(
        normalized.grantOwnership.passiveSourcesByAbilityId,
      ),
    },
  };
}

function restoreAbilityState(snapshot: AbilityStateSnapshot, frameCount: number) {
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
    [...normalized.appliedPassiveAbilityIds].filter((abilityId) => {
      const def = getAbilityDefinition(abilityId);
      return def?.kind === 'passive';
    }),
  );
  return normalized;
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PlayerCarryoverSnapshotError(`Expected array at ${path}`);
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
      'generatedEquipmentRewardBundles' in record)
  ) {
    throw new PlayerCarryoverSnapshotError(
      'Unversioned player carryover cannot contain generated equipment state',
    );
  }
  const legacy = record as unknown as LegacyPlayerCarryoverSnapshot;
  const normalized =
    record.schemaVersion === PLAYER_CARRYOVER_SCHEMA_VERSION
      ? (input as PlayerCarryoverSnapshot)
      : ({
          ...legacy,
          schemaVersion: PLAYER_CARRYOVER_SCHEMA_VERSION,
          generatedInventoryInstanceKeys: [],
          generatedEquippedInstanceKeys: [],
          generatedEquipmentRewardBundles: [],
        } satisfies PlayerCarryoverSnapshot);
  assertArray(normalized.inventorySlots, 'inventorySlots');
  assertArray(normalized.equippedItemIds, 'equippedItemIds');
  assertArray(normalized.generatedInventoryInstanceKeys, 'generatedInventoryInstanceKeys');
  assertArray(normalized.generatedEquippedInstanceKeys, 'generatedEquippedInstanceKeys');
  assertArray(normalized.generatedEquipmentRewardBundles, 'generatedEquipmentRewardBundles');
  assertArray(normalized.disabledEquipmentSlots, 'disabledEquipmentSlots');
  return normalized;
}

interface ValidatedGeneratedCarryover {
  readonly snapshot: PlayerCarryoverSnapshot;
  readonly instancesByKey: ReadonlyMap<GeneratedEquipmentInstanceKey, GeneratedEquipmentInstanceV1>;
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

function validateGrantOwnership(
  abilityState: AbilityStateSnapshot | undefined,
  equippedInstances: readonly GeneratedEquipmentInstanceV1[],
): void {
  // Validate frozen grant projection fidelity and build expected source set.
  type ExpectedSource = {
    readonly abilityId: string;
    readonly kind: 'abilityGrant' | 'passiveGrant';
    readonly instanceId: string;
    readonly effectOrdinal: number;
  };
  const expectedSources: ExpectedSource[] = [];
  for (const instance of equippedInstances) {
    const abilityGrantIds = instance.resolvedEffects.flatMap((effect) =>
      'kind' in effect && effect.kind === 'abilityGrant'
        ? [(effect as { grantId: string }).grantId]
        : [],
    );
    const passiveGrantIds = instance.resolvedEffects.flatMap((effect) =>
      'kind' in effect && effect.kind === 'passiveGrant'
        ? [(effect as { grantId: string }).grantId]
        : [],
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
      if (!('kind' in effect) || (effect.kind !== 'abilityGrant' && effect.kind !== 'passiveGrant'))
        continue;
      expectedSources.push({
        abilityId: (effect as { grantId: string }).grantId,
        kind: (effect as { kind: 'abilityGrant' | 'passiveGrant' }).kind,
        instanceId: instance.instanceId,
        effectOrdinal: effect.effectOrdinal,
      });
    }
  }

  if (expectedSources.length === 0) return;

  // Validate that all expected generated-equipment sources appear in the grant-source maps.
  // The snapshot stores sources as arrays of tuples (JSON-serializable); convert to Maps of Sets.
  const toSourcesMap = (
    entries: readonly (readonly [string, readonly AbilityGrantSourceId[]])[] | undefined,
  ): Map<string, Set<AbilityGrantSourceId>> =>
    new Map((entries ?? []).map(([id, sources]) => [id, new Set(sources)]));

  const activeSourcesByAbilityId = toSourcesMap(
    abilityState?.grantOwnership?.activeSourcesByAbilityId,
  );
  const passiveSourcesByAbilityId = toSourcesMap(
    abilityState?.grantOwnership?.passiveSourcesByAbilityId,
  );

  for (const expected of expectedSources) {
    const sourcesMap =
      expected.kind === 'abilityGrant' ? activeSourcesByAbilityId : passiveSourcesByAbilityId;
    const sources = sourcesMap.get(expected.abilityId) ?? new Set<AbilityGrantSourceId>();
    const expectedSourceId = equipmentAbilityGrantSourceId(
      expected.instanceId as GeneratedEquipmentInstanceId,
      expected.effectOrdinal,
    );
    if (!sources.has(expectedSourceId)) {
      throw new PlayerCarryoverSnapshotError(
        `Missing generated grant source for ${expected.abilityId} from instance ${expected.instanceId}:${expected.effectOrdinal}`,
      );
    }
  }
}

function validateGeneratedCarryover(world: GameWorld, input: unknown): ValidatedGeneratedCarryover {
  const snapshot = normalizePlayerCarryoverSnapshot(input);
  const hasGeneratedReferences =
    snapshot.generatedInventoryInstanceKeys.length > 0 ||
    snapshot.generatedEquippedInstanceKeys.length > 0 ||
    snapshot.generatedEquipmentRewardBundles.length > 0;
  // Note: abilityState grant sources are NOT checked here.  Static equipment
  // sources (kind: 'equipment') are stripped by snapshotAbilityState, so any
  // surviving sources are non-generated (learned, skill, etc.).
  // Generated-equipment sources can only exist when instances are equipped,
  // which is already covered by generatedEquippedInstanceKeys above.
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

  const bundleIds = new Set<string>();
  for (const bundle of snapshot.generatedEquipmentRewardBundles) {
    if (bundle.schemaVersion !== GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION) {
      throw new PlayerCarryoverSnapshotError(
        `Unsupported generated reward bundle version: ${String(bundle.schemaVersion)}`,
      );
    }
    if (bundleIds.has(bundle.achievementId)) {
      throw new PlayerCarryoverSnapshotError(
        `Duplicate generated reward bundle: ${bundle.achievementId}`,
      );
    }
    if (typeof bundle.achievementId !== 'string' || bundle.achievementId.length === 0) {
      throw new PlayerCarryoverSnapshotError('Generated reward bundle requires an achievement id');
    }
    bundleIds.add(bundle.achievementId);
    assertUniqueStrings(bundle.instanceKeys, `rewardBundles.${bundle.achievementId}.instanceKeys`);
    for (const key of bundle.instanceKeys) claim(key, `reward-bundle:${bundle.achievementId}`);
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
  const generatedWeapons = equippedInstances.filter(
    (instance) => instance.frozen.activeWeaponSnapshot !== null,
  );
  if (generatedWeapons.length > 1) {
    throw new PlayerCarryoverSnapshotError(
      'Multiple generated active weapon snapshots are equipped',
    );
  }
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
  const seenInstances = new Set<number>();
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
      if (seenInstances.has(instanceId)) continue;
      const instance = equipment.instances.get(instanceId);
      if (!instance) {
        throw new Error(`Missing equipped instance ${instanceId} while capturing player carryover`);
      }
      seenInstances.add(instanceId);
      equippedItemIds.push(instance.def.id);
    }
  }

  const inventory = world.inventories.get(playerEid);
  const abilityState = snapshotAbilityState(
    world.abilityStatesByEntity.get(playerEid),
    world.frameCount,
  );
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
    disabledEquipmentSlots: equipment ? [...equipment.disabledSlots] : [],
    playerSkills: [...world.playerSkills].map(([id, state]) => [id, snapshotSkillState(state)]),
    ...(abilityState ? { abilityState } : {}),
    persistentStatModifiers: world.statModifiers
      .filter(
        (modifier) =>
          (modifier.sourceType === 'skill' || modifier.sourceType === 'ability') &&
          !isPassiveAbilityModifier(modifier) &&
          (modifier.expiresFrame === undefined || modifier.expiresFrame > world.frameCount) &&
          modifierBelongsToPlayer(modifier, playerEid),
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
  // Merge with latch semantics: preserve any unlock the destination scenario
  // has already forced to true (e.g. initializeFloor2Scenario sets inventory,
  // equipment, and spells before calling this). A Floor 1 run that never
  // triggered those progressive unlocks would otherwise turn them back off.
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
  statSystem(world);

  world.inventories.set(playerEid, {
    slots: snapshot.inventorySlots.map((slot) => ({ ...slot })),
  });
  const restoredSkills = new Map(
    snapshot.playerSkills.map(([id, state]) => [id, restoreSkillState(state)]),
  );
  world.playerSkills = restoredSkills;
  world.skillStatesByEntity.set(playerEid, new Map(restoredSkills));
  if (snapshot.abilityState) {
    world.abilityStatesByEntity.set(
      playerEid,
      restoreAbilityState(snapshot.abilityState, world.frameCount),
    );
    synchronizeAbilityPassives(world, playerEid);
  } else {
    world.abilityStatesByEntity.delete(playerEid);
  }

  if (snapshot.generatedEquipmentRegistry) {
    restoreGeneratedEquipmentRegistry(world, snapshot.generatedEquipmentRegistry);
  }
  world.generatedEquipmentRewardBundles = new Map();

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

  statSystem(world);
  world.stores.health.current[playerEid] = snapshot.health.current;
  world.stores.health.max[playerEid] = snapshot.health.max;
  world.stores.broadcastScore.current[playerEid] = snapshot.broadcastScore;
}
