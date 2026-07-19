import type { GameWorld } from '../core/world.js';
import {
  clearEquipmentState,
  equip,
  getEquipmentState,
  initializeBaseStats,
} from '../core/systems/equipmentSystem.js';
import { statSystem } from '../core/systems/statSystem.js';
import { SLOT_REGISTRY, type EquipmentSlotId } from '../shared/equipment-slots.js';
import { getEquipmentDefForItem } from '../shared/equipmentDefs.js';
import { ALL_STAT_IDS, PRIMARY_STATS, type PrimaryStatId, type StatId } from '../shared/stats.js';
import {
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  abilityGrantSourceCategory,
  type AbilityGrantSource,
  type AbilityGrantSourceId,
  type AbilityState,
  type AbilityStateLike,
} from '../shared/abilities.js';
import type { AchievementBooleanFact, AchievementNumberFact } from '../shared/achievements.js';
import type { PlayerLevel, SkillState, StatModifier } from '../shared/skills.js';
import {
  migrateAbilityStateToSourceTracking,
  synchronizeAbilityPassives,
} from './systems/abilitySystem.js';

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
  readonly appliedPassiveAbilityIds: readonly string[];
  /** C2: source-tracking maps. Optional for backward-compat with old snapshots. */
  readonly activeAbilityGrantSources?: readonly (readonly [
    string,
    readonly AbilityGrantSource[],
  ])[];
  readonly passiveAbilityGrantSources?: readonly (readonly [
    string,
    readonly AbilityGrantSource[],
  ])[];
  readonly grantOwnership?: {
    readonly schemaVersion: typeof ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION;
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
  readonly disabledEquipmentSlots: readonly EquipmentSlotId[];
  readonly playerSkills: readonly (readonly [string, SkillStateSnapshot])[];
  readonly abilityState?: AbilityStateSnapshot;
  readonly persistentStatModifiers: readonly StatModifierSnapshot[];
  readonly featureUnlocks: Readonly<GameWorld['featureUnlocks']>;
  readonly achievements: {
    readonly unlockedIds: readonly string[];
    readonly pendingUnlockIds: readonly string[];
    readonly claimedIds: readonly string[];
    readonly runGlobal: {
      readonly numberFacts: Readonly<Record<AchievementNumberFact, number>>;
      readonly booleanFacts: Readonly<Record<AchievementBooleanFact, boolean>>;
      readonly completedQuestIds: readonly string[];
    };
  };
}

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

  // Strip equipment-sourced entries from the snapshot.  Equipment instance IDs
  // are allocated per-world and are not stable across floor transitions; storing
  // them would produce stale references after carryover restore.  Abilities
  // whose *only* source was equipment are also dropped from the ID lists here —
  // they will be re-granted when the carried-over equipment is re-equipped.
  // Abilities with mixed sources (e.g. learned + equipment) survive with their
  // non-equipment sources intact.
  //
  // TODO(C2→D): when equipment-ability wiring is fully implemented, persist a
  // compact itemDef→abilityId manifest here and re-grant on restore so equipment
  // abilities survive the transition without stale instanceId references.
  const nonEquipmentSources = (sources: readonly AbilityGrantSource[]): AbilityGrantSource[] =>
    sources.filter((s) => s.kind !== 'equipment');
  const hasNonEquipmentLegacySource = (kind: 'active' | 'passive', abilityId: string): boolean => {
    const sources =
      kind === 'active'
        ? (state.activeAbilityGrantSources.get(abilityId) ?? [])
        : (state.passiveAbilityGrantSources.get(abilityId) ?? []);
    return sources.some((source) => source.kind !== 'equipment');
  };
  const nonEquipmentSourceIds = (
    kind: 'active' | 'passive',
    abilityId: string,
    sources: ReadonlySet<AbilityGrantSourceId> | undefined,
  ): AbilityGrantSourceId[] =>
    [...(sources ?? [])].filter((sourceId) => {
      const category = abilityGrantSourceCategory(sourceId);
      if (category === 'equipment') return false;
      if (category === 'legacy') {
        return hasNonEquipmentLegacySource(kind, abilityId);
      }
      return true;
    });
  const legacySourceFromOwnership = (
    sourceId: AbilityGrantSourceId,
  ): AbilityGrantSource | undefined => {
    const category = abilityGrantSourceCategory(sourceId);
    if (category === 'learned') {
      return { kind: 'learned' };
    }
    if (category === 'skill') {
      const [, skillId] = sourceId.split(':');
      return skillId === undefined ? undefined : { kind: 'skill', skillId };
    }
    return undefined;
  };

  const filteredActiveSources = new Map<string, AbilityGrantSource[]>();
  for (const [abilityId, sources] of state.activeAbilityGrantSources) {
    const kept = nonEquipmentSources(sources);
    if (kept.length > 0) filteredActiveSources.set(abilityId, kept);
  }
  const filteredPassiveSources = new Map<string, AbilityGrantSource[]>();
  for (const [abilityId, sources] of state.passiveAbilityGrantSources) {
    const kept = nonEquipmentSources(sources);
    if (kept.length > 0) filteredPassiveSources.set(abilityId, kept);
  }
  const filteredOwnedActives = new Map<string, AbilityGrantSourceId[]>();
  const ownedActiveEntries = state.grantOwnership?.activeSourcesByAbilityId ?? new Map();
  for (const [abilityId, sources] of ownedActiveEntries) {
    const kept = nonEquipmentSourceIds('active', abilityId, sources);
    if (kept.length > 0) {
      filteredOwnedActives.set(abilityId, kept);
      if (!filteredActiveSources.has(abilityId)) {
        const legacySources = kept
          .map(legacySourceFromOwnership)
          .filter((source): source is AbilityGrantSource => source !== undefined);
        if (legacySources.length > 0) {
          filteredActiveSources.set(abilityId, legacySources);
        }
      }
    }
  }
  const filteredOwnedPassives = new Map<string, AbilityGrantSourceId[]>();
  const ownedPassiveEntries = state.grantOwnership?.passiveSourcesByAbilityId ?? new Map();
  for (const [abilityId, sources] of ownedPassiveEntries) {
    const kept = nonEquipmentSourceIds('passive', abilityId, sources);
    if (kept.length > 0) {
      filteredOwnedPassives.set(abilityId, kept);
      if (!filteredPassiveSources.has(abilityId)) {
        const legacySources = kept
          .map(legacySourceFromOwnership)
          .filter((source): source is AbilityGrantSource => source !== undefined);
        if (legacySources.length > 0) {
          filteredPassiveSources.set(abilityId, legacySources);
        }
      }
    }
  }

  // Drop equipment-only abilities from the canonical ID lists.
  const equippedActiveAbilityIds = state.equippedActiveAbilityIds.filter(
    (id: string) =>
      filteredActiveSources.has(id) ||
      filteredOwnedActives.has(id) ||
      (!state.activeAbilityGrantSources.has(id) &&
        !(state.grantOwnership?.activeSourcesByAbilityId.has(id) ?? false)),
  );
  const passiveAbilityIds = state.passiveAbilityIds.filter(
    (id: string) =>
      filteredPassiveSources.has(id) ||
      filteredOwnedPassives.has(id) ||
      (!state.passiveAbilityGrantSources.has(id) &&
        !(state.grantOwnership?.passiveSourcesByAbilityId.has(id) ?? false)),
  );

  return {
    learnedSpellIds: [...state.learnedSpellIds],
    equippedActiveAbilityIds,
    passiveAbilityIds,
    cooldownElapsedFramesByAbilityId: [...state.cooldownByAbilityId].map(
      ([abilityId, lastTriggerFrame]) =>
        [abilityId, Math.max(0, frameCount - lastTriggerFrame)] as const,
    ),
    cooldownFramesByAbilityId: [...state.cooldownFramesByAbilityId],
    appliedPassiveAbilityIds: [],
    activeAbilityGrantSources: [...filteredActiveSources].map(
      ([abilityId, sources]) => [abilityId, [...sources]] as const,
    ),
    passiveAbilityGrantSources: [...filteredPassiveSources].map(
      ([abilityId, sources]) => [abilityId, [...sources]] as const,
    ),
    grantOwnership: state.grantOwnership
      ? {
          schemaVersion: state.grantOwnership.schemaVersion,
          activeSourcesByAbilityId: [...filteredOwnedActives].map(
            ([abilityId, sources]) => [abilityId, [...sources]] as const,
          ),
          passiveSourcesByAbilityId: [...filteredOwnedPassives].map(
            ([abilityId, sources]) => [abilityId, [...sources]] as const,
          ),
        }
      : undefined,
  };
}

function restoreAbilityState(snapshot: AbilityStateSnapshot, frameCount: number): AbilityState {
  const restored: AbilityState = {
    learnedSpellIds: [...snapshot.learnedSpellIds],
    equippedActiveAbilityIds: [...snapshot.equippedActiveAbilityIds],
    passiveAbilityIds: [...snapshot.passiveAbilityIds],
    cooldownByAbilityId: new Map(
      snapshot.cooldownElapsedFramesByAbilityId.map(
        ([abilityId, elapsedFrames]) => [abilityId, frameCount - elapsedFrames] as const,
      ),
    ),
    cooldownFramesByAbilityId: new Map(snapshot.cooldownFramesByAbilityId),
    appliedPassiveAbilityIds: new Set(snapshot.appliedPassiveAbilityIds),
    activeAbilityGrantSources: snapshot.activeAbilityGrantSources
      ? new Map(snapshot.activeAbilityGrantSources.map(([id, srcs]) => [id, [...srcs]]))
      : new Map(),
    passiveAbilityGrantSources: snapshot.passiveAbilityGrantSources
      ? new Map(snapshot.passiveAbilityGrantSources.map(([id, srcs]) => [id, [...srcs]]))
      : new Map(),
    grantOwnership: snapshot.grantOwnership
      ? {
          schemaVersion: snapshot.grantOwnership.schemaVersion,
          activeSourcesByAbilityId: new Map(
            snapshot.grantOwnership.activeSourcesByAbilityId.map(([id, srcs]) => [
              id,
              new Set(srcs),
            ]),
          ),
          passiveSourcesByAbilityId: new Map(
            snapshot.grantOwnership.passiveSourcesByAbilityId.map(([id, srcs]) => [
              id,
              new Set(srcs),
            ]),
          ),
        }
      : undefined,
  };
  if (restored.grantOwnership !== undefined) {
    return restored;
  }
  // Back-fill source tracking for abilities restored from old snapshots that
  // lacked the grant-source maps (backward-compat A1 contract migration).
  migrateAbilityStateToSourceTracking(restored);
  return restored;
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

  const inventory = world.inventories.get(playerEid);
  if ((inventory?.generatedEquipment?.length ?? 0) > 0) {
    throw new Error(
      'Generated equipment carryover is not supported until the B3 persistence slice lands',
    );
  }

  const equipment = getEquipmentState(world, playerEid);
  const equippedItemIds: string[] = [];
  const seenInstances = new Set<number>();
  if (equipment) {
    for (const slot of SLOT_REGISTRY) {
      const instanceId = equipment.equipped[slot.id];
      if (instanceId == null) {
        continue;
      }
      if (typeof instanceId !== 'number') {
        throw new Error(
          'Generated equipment carryover is not supported until the B3 persistence slice lands',
        );
      }
      if (seenInstances.has(instanceId)) {
        continue;
      }
      const instance = equipment.instances.get(instanceId);
      if (!instance) {
        throw new Error(`Missing equipped instance ${instanceId} while capturing player carryover`);
      }
      seenInstances.add(instanceId);
      equippedItemIds.push(instance.def.id);
    }
  }

  const abilityState = snapshotAbilityState(
    world.abilityStatesByEntity.get(playerEid),
    world.frameCount,
  );

  return {
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
      runGlobal: {
        numberFacts: { ...world.achievements.runGlobal.numberFacts },
        booleanFacts: { ...world.achievements.runGlobal.booleanFacts },
        completedQuestIds: [...world.achievements.runGlobal.completedQuestIds],
      },
    },
  };
}

export function restorePlayerCarryover(
  world: GameWorld,
  playerEid: number,
  snapshot: PlayerCarryoverSnapshot,
): void {
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
    runGlobal: {
      numberFacts: { ...snapshot.achievements.runGlobal.numberFacts },
      booleanFacts: { ...snapshot.achievements.runGlobal.booleanFacts },
      completedQuestIds: new Set(snapshot.achievements.runGlobal.completedQuestIds),
    },
  };

  clearEquipmentState(world, playerEid);
  initializeBaseStats(world, playerEid, snapshot.baseStats);
  for (const statId of PRIMARY_STATS) {
    world.stores.coreStatPoints[statId][playerEid] = snapshot.coreStatPoints[statId];
  }

  const floorModifiers = world.statModifiers.filter((modifier) => modifier.sourceType === 'floor');
  world.statModifiers = [
    ...floorModifiers,
    ...snapshot.persistentStatModifiers.map(({ expiresInFrames, ...modifier }) => ({
      ...modifier,
      sourceId: remapModifierHolder(modifier, snapshot.sourcePlayerEid, playerEid),
      ...(expiresInFrames === undefined
        ? {}
        : { expiresFrame: world.frameCount + expiresInFrames }),
    })),
  ];
  statSystem(world);

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
  const equipment = getEquipmentState(world, playerEid);
  if (!equipment) {
    throw new Error('Equipment state missing after player carryover restore');
  }
  for (const slotId of snapshot.disabledEquipmentSlots) {
    equipment.disabledSlots.add(slotId);
  }

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

  statSystem(world);
  world.stores.health.current[playerEid] = snapshot.health.current;
  world.stores.health.max[playerEid] = snapshot.health.max;
  world.stores.broadcastScore.current[playerEid] = snapshot.broadcastScore;
}
