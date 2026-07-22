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
    /** Optional for backward compatibility with pre-scoped carryover snapshots. */
    readonly carriedRunFacts?: AchievementFactSnapshot;
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
  const seenInstances = new Set<number>();
  if (equipment) {
    for (const slot of SLOT_REGISTRY) {
      const instanceId = equipment.equipped[slot.id];
      if (instanceId == null) continue;
      if (typeof instanceId !== 'number') {
        throw new Error(
          'Generated equipment carryover is not supported until the B3 persistence slice lands',
        );
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
  if ((inventory?.generatedEquipment?.length ?? 0) > 0) {
    throw new Error(
      'Generated equipment carryover is not supported until the B3 persistence slice lands',
    );
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
      carriedRunFacts: mergeAchievementFactSnapshots(
        world.achievements.carriedRunFacts,
        collectCurrentFloorAchievementFacts(world),
      ),
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
    carriedRunFacts: cloneAchievementFactSnapshot(snapshot.achievements.carriedRunFacts),
  };

  clearEquipmentState(world, playerEid);
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
