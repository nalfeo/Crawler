import { describe, expect, it } from 'vitest';
import { addEntity, entityExists } from 'bitecs';
import { spawnPlayer } from '../../src/core/helpers.js';
import { spawnBossChestEntity } from '../../src/core/spawners/world-objects.js';
import { createBossChestRecord } from '../../src/core/systems/bossChestRewards.js';
import {
  addGeneratedEquipmentToBag,
  equip,
  equipFromBag,
  getEquipmentState,
  unequip,
} from '../../src/core/systems/equipmentSystem.js';
import { addStatModifier } from '../../src/game/systems/statsSystem.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { resolveEquipmentRewardBundle } from '../../src/game/floor2-reward-bundle-resolver.js';
import { memorizeSpell } from '../../src/game/systems/abilitySystem.js';
import { createEmptyAchievementFactSnapshot } from '../../src/shared/achievements.js';
import {
  abilitySystem,
  grantPassiveAbility,
  grantAbilitySources,
  normalizeAbilityState,
} from '../../src/game/systems/abilitySystem.js';
import {
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  learnedAbilityGrantSourceId,
  skillAbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import {
  getEquipmentDefForStarterWeapon,
  MERCHANTS_CHARM_DEF,
} from '../../src/shared/equipmentDefs.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  type GeneratedEquipmentInstanceKey,
} from '../../src/shared/generated-equipment-types.js';
import {
  createGeneratedEquipmentInstance,
  snapshotGeneratedEquipmentRegistry,
} from '../../src/core/generated-equipment-registry.js';
import { getActiveWeaponDef, getActiveWeaponSnapshot } from '../../src/core/active-weapon.js';
import { addItem, listGeneratedEquipmentReferences } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';
import { SKILL_LEVEL5_ABILITY_GRANTS } from '../../src/game/abilities/registry.js';

describe('player floor carryover', () => {
  it('restores run-wide progression without copying the previous floor modifier', () => {
    const source = createTestWorld({ seed: 42 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const sword = getEquipmentDefForStarterWeapon('sword');
    expect(sword).toBeDefined();
    expect(equip(source, sourcePlayer, sword!, { force: true }).ok).toBe(true);
    expect(equip(source, sourcePlayer, MERCHANTS_CHARM_DEF, { force: true }).ok).toBe(true);

    source.playerName = 'Carry Rhea';
    source.playerGender = 'other';
    source.playerLevel = { xp: 321, level: 7, unspentPoints: 4, pointsPerLevel: 3 };
    source.playerGold = 99;
    source.stores.broadcastScore.current[sourcePlayer] = 456;
    source.stores.coreStatPoints.strength[sourcePlayer] = 6;
    source.stores.coreStatPoints.constitution[sourcePlayer] = 5;
    source.stores.health.current[sourcePlayer] = 137;
    source.stores.health.max[sourcePlayer] = 260;
    addItem(source.inventories.get(sourcePlayer)!, 'throwing-knife', 3);
    source.playerSkills.set('weapon-class-slashing', {
      level: 3,
      usage: 12,
      itemBonus: 1,
      triggeredMilestones: new Set([2]),
    });
    source.skillStatesByEntity.set(sourcePlayer, new Map(source.playerSkills));
    source.abilityStatesByEntity.set(sourcePlayer, {
      learnedSpellIds: ['fireball'],
      equippedActiveAbilityIds: ['fireball'],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map([['fireball', 980]]),
      cooldownFramesByAbilityId: new Map([['fireball', 120]]),
      appliedPassiveAbilityIds: new Set(),
    });
    source.frameCount = 1000;
    source.featureUnlocks = { inventory: true, equipment: true, spells: true };
    source.achievements.unlockedIds.add('first-blood');
    source.achievements.pendingUnlockIds.push('first-blood');
    source.achievements.carriedRunFacts = {
      ...source.achievements.carriedRunFacts,
      numberFacts: { ...source.achievements.carriedRunFacts.numberFacts, totalKills: 99 },
      booleanFacts: {
        ...source.achievements.carriedRunFacts.booleanFacts,
        staircaseUnlocked: true,
      },
      completedQuestIds: ['floor1-find-welcome'],
    };
    addStatModifier(source, {
      sourceType: 'skill',
      sourceId: `weapon-class-slashing:level:3:${sourcePlayer}`,
      stat: 'damage',
      op: 'add',
      value: 2,
    });
    addStatModifier(source, {
      sourceType: 'ability',
      sourceId: `fireball:active:${sourcePlayer}`,
      stat: 'damage',
      op: 'multiply',
      value: 1.2,
      expiresFrame: 1010,
    });
    addStatModifier(source, {
      sourceType: 'ability',
      sourceId: 'foreign-passive:passive:1:0',
      stat: 'damage',
      op: 'add',
      value: 100,
    });
    addStatModifier(source, {
      sourceType: 'skill',
      sourceId: 'foreign-skill:level:5:1',
      stat: 'damage',
      op: 'add',
      value: 100,
    });
    addStatModifier(source, {
      sourceType: 'floor',
      sourceId: 'floor1-only',
      stat: 'moveSpeed',
      op: 'add',
      value: 5,
    });

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const destination = createTestWorld({ seed: 42, floor: 2 });
    addEntity(destination.ecs);
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    addStatModifier(destination, {
      sourceType: 'floor',
      sourceId: 'floor2-only',
      stat: 'pickupRange',
      op: 'add',
      value: 1,
    });

    restorePlayerCarryover(destination, destinationPlayer, snapshot);

    expect(destination.playerName).toBe('Carry Rhea');
    expect(destination.playerGender).toBe('other');
    expect(destination.playerLevel).toEqual(source.playerLevel);
    expect(destination.playerGold).toBe(99);
    expect(destination.stores.broadcastScore.current[destinationPlayer]).toBe(456);
    expect(destination.stores.coreStatPoints.strength[destinationPlayer]).toBe(6);
    expect(destination.stores.coreStatPoints.constitution[destinationPlayer]).toBe(5);
    expect(destination.stores.health.current[destinationPlayer]).toBe(137);
    expect(destination.stores.health.max[destinationPlayer]).toBe(260);
    expect(destination.inventories.get(destinationPlayer)).toEqual(
      source.inventories.get(sourcePlayer),
    );

    const restoredEquipment = getEquipmentState(destination, destinationPlayer);
    const restoredItemIds = new Set(
      [...(restoredEquipment?.instances.values() ?? [])].map((instance) => instance.def.id),
    );
    expect(restoredItemIds).toEqual(new Set([sword!.id, MERCHANTS_CHARM_DEF.id]));
    expect(destination.playerSkills.get('weapon-class-slashing')).toEqual(
      source.playerSkills.get('weapon-class-slashing'),
    );
    expect(destination.abilityStatesByEntity.get(destinationPlayer)).toEqual(
      expect.objectContaining({
        cooldownByAbilityId: new Map([['fireball', -20]]),
        cooldownFramesByAbilityId: new Map([['fireball', 120]]),
      }),
    );
    expect(destination.playerSkills.get('weapon-class-slashing')).toBe(
      destination.skillStatesByEntity.get(destinationPlayer)?.get('weapon-class-slashing'),
    );
    expect(destination.featureUnlocks).toEqual(source.featureUnlocks);
    expect(destination.achievements.unlockedIds).toEqual(source.achievements.unlockedIds);
    expect(destination.achievements.carriedRunFacts.numberFacts.totalKills).toBe(99);
    expect(destination.achievements.carriedRunFacts.booleanFacts.staircaseUnlocked).toBe(true);
    expect(destination.achievements.carriedRunFacts.completedQuestIds).toContain(
      'floor1-find-welcome',
    );
    expect(destination.statModifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'floor2-only' }),
        expect.objectContaining({
          sourceId: `weapon-class-slashing:level:3:${destinationPlayer}`,
        }),
        expect.objectContaining({
          sourceId: `fireball:active:${destinationPlayer}`,
          expiresFrame: 10,
        }),
      ]),
    );
    expect(destination.statModifiers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'floor1-only' }),
        expect.objectContaining({ sourceId: 'foreign-passive:passive:1:0' }),
        expect.objectContaining({ sourceId: 'foreign-skill:level:5:1' }),
      ]),
    );
  });

  it('round-trips ownership and reconstructs passives without duplicating modifiers', () => {
    const source = createTestWorld({ seed: 91 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const learned = learnedAbilityGrantSourceId('fireball');
    const skill = skillAbilityGrantSourceId('iron-skin', 5);
    grantAbilitySources(source, sourcePlayer, [
      { kind: 'active', abilityId: 'fireball', sourceId: learned },
      { kind: 'passive', abilityId: 'veteran-instinct', sourceId: skill },
    ]);
    abilitySystem(source);

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    expect(snapshot.persistentStatModifiers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: expect.stringContaining(':passive:') }),
      ]),
    );

    const destination = createTestWorld({ seed: 91, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    restorePlayerCarryover(destination, destinationPlayer, snapshot);
    restorePlayerCarryover(destination, destinationPlayer, snapshot);

    const restoredState = destination.abilityStatesByEntity.get(destinationPlayer);
    if (!restoredState) throw new Error('Expected restored ability state');
    const state = normalizeAbilityState(restoredState);
    expect(state).toEqual(
      expect.objectContaining({
        learnedSpellIds: ['fireball'],
        passiveAbilityIds: ['veteran-instinct'],
      }),
    );
    expect(state.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set([learned]),
    );
    expect(state.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set([skill]),
    );
    expect(
      destination.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith(`veteran-instinct:passive:${destinationPlayer}:`),
      ),
    ).toHaveLength(2);
  });

  it('preserves learned passive provenance across carryover snapshots', () => {
    const source = createTestWorld({ seed: 191 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const learned = learnedAbilityGrantSourceId('veteran-instinct');

    grantPassiveAbility(source, sourcePlayer, 'veteran-instinct');
    abilitySystem(source);

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const destination = createTestWorld({ seed: 191, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, snapshot);

    const restoredState = destination.abilityStatesByEntity.get(destinationPlayer);
    if (!restoredState) throw new Error('Expected restored ability state');
    const state = normalizeAbilityState(restoredState);
    expect(state.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set([learned]),
    );
    expect(
      destination.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith(`veteran-instinct:passive:${destinationPlayer}:`),
      ),
    ).toHaveLength(2);
  });

  it('preserves legacy applied passives without duplicating persisted modifiers', () => {
    const source = createTestWorld({ seed: 92 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    grantAbilitySources(source, sourcePlayer, [
      {
        kind: 'passive',
        abilityId: 'veteran-instinct',
        sourceId: skillAbilityGrantSourceId('iron-skin', 5),
      },
    ]);
    abilitySystem(source);

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const persistedPassiveModifiers = source.statModifiers
      .filter((modifier) =>
        modifier.sourceId.startsWith(`veteran-instinct:passive:${sourcePlayer}:`),
      )
      .map(({ expiresFrame: _expiresFrame, ...modifier }) => modifier);
    const { grantOwnership: _grantOwnership, ...legacyAbilityState } = snapshot.abilityState!;
    const legacySnapshot = {
      ...snapshot,
      abilityState: {
        ...legacyAbilityState,
        appliedPassiveAbilityIds: ['veteran-instinct'],
      },
      persistentStatModifiers: [...snapshot.persistentStatModifiers, ...persistedPassiveModifiers],
    };
    const destination = createTestWorld({ seed: 92, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacySnapshot);

    expect(
      destination.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith(`veteran-instinct:passive:${destinationPlayer}:`),
      ),
    ).toHaveLength(persistedPassiveModifiers.length);
    expect(
      destination.abilityStatesByEntity
        .get(destinationPlayer)
        ?.appliedPassiveAbilityIds.has('veteran-instinct'),
    ).toBe(true);
  });

  it('restores old plain-id snapshots through deterministic legacy migration', () => {
    const source = createTestWorld({ seed: 17 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    source.abilityStatesByEntity.set(sourcePlayer, {
      learnedSpellIds: ['fireball'],
      equippedActiveAbilityIds: ['fireball', 'battle-focus'],
      passiveAbilityIds: ['veteran-instinct'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    });
    const currentSnapshot = capturePlayerCarryover(source, sourcePlayer);
    const abilityState = currentSnapshot.abilityState!;
    const { grantOwnership: _grantOwnership, ...legacyAbilityState } = abilityState;
    const legacySnapshot = {
      ...currentSnapshot,
      abilityState: {
        ...legacyAbilityState,
        equippedActiveAbilityIds: [...legacyAbilityState.equippedActiveAbilityIds, 'retired-spell'],
        passiveAbilityIds: [...legacyAbilityState.passiveAbilityIds, 'retired-passive'],
        appliedPassiveAbilityIds: ['veteran-instinct', 'retired-passive'],
      },
      persistentStatModifiers: [
        ...currentSnapshot.persistentStatModifiers,
        {
          sourceType: 'ability' as const,
          sourceId: `retired-spell:active:${sourcePlayer}`,
          stat: 'damage' as const,
          op: 'add' as const,
          value: 1.5,
        },
        {
          sourceType: 'ability' as const,
          sourceId: `retired-passive:passive:${sourcePlayer}:0`,
          stat: 'armor' as const,
          op: 'add' as const,
          value: 2,
        },
      ],
    };
    const destination = createTestWorld({ seed: 17, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacySnapshot);

    const restoredState = destination.abilityStatesByEntity.get(destinationPlayer);
    if (!restoredState) throw new Error('Expected restored ability state');
    const restored = normalizeAbilityState(restoredState);
    expect(restored.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set(['learned:fireball']),
    );
    expect(restored.grantOwnership.activeSourcesByAbilityId.get('battle-focus')).toEqual(
      new Set(['legacy:active:battle-focus']),
    );
    expect(restored.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set(['legacy:passive:veteran-instinct']),
    );
    expect(restored.grantOwnership.activeSourcesByAbilityId.get('retired-spell')).toEqual(
      new Set(['legacy:active:retired-spell']),
    );
    expect(restored.grantOwnership.passiveSourcesByAbilityId.get('retired-passive')).toEqual(
      new Set(['legacy:passive:retired-passive']),
    );
    expect(restored.learnedSpellIds).not.toContain('retired-spell');
    expect(restored.equippedActiveAbilityIds).not.toContain('retired-spell');
    expect(restored.passiveAbilityIds).not.toContain('retired-passive');
    expect(restored.appliedPassiveAbilityIds.has('retired-passive')).toBe(false);
    expect(restored.appliedPassiveAbilityIds.has('veteran-instinct')).toBe(true);
    expect(
      destination.statModifiers.some(
        (modifier) => modifier.sourceId === `retired-spell:active:${destinationPlayer}`,
      ),
    ).toBe(false);
    expect(
      destination.statModifiers.some(
        (modifier) => modifier.sourceId === `retired-passive:passive:${destinationPlayer}:0`,
      ),
    ).toBe(false);
  });

  it('normalizes a current-schema snapshot missing the generated-state array fields to empty arrays', () => {
    // Simulates a pre-existing snapshot saved before generated-equipment /
    // loot-box carryover fields were introduced: same schemaVersion, but the
    // newer array fields are entirely absent from the record (not just
    // empty). Restoring it must default them to [] rather than crash.
    const source = createTestWorld({ seed: 91 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const fullSnapshot = capturePlayerCarryover(source, sourcePlayer);
    const {
      generatedInventoryInstanceKeys: _keys,
      generatedEquippedInstanceKeys: _equipped,
      generatedEquipmentRewardBundles: _rewardBundles,
      lootBoxRewardBundles: _lootBoxBundles,
      ...snapshotMissingGeneratedFields
    } = fullSnapshot;

    const destination = createTestWorld({ seed: 91 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() =>
      restorePlayerCarryover(destination, destinationPlayer, snapshotMissingGeneratedFields),
    ).not.toThrow();
    expect(destination.generatedEquipmentRewardBundles.size).toBe(0);
    expect(destination.lootBoxRewardBundles.size).toBe(0);
    const restoredBag = destination.inventories.get(destinationPlayer);
    expect(restoredBag ? listGeneratedEquipmentReferences(restoredBag) : undefined).toEqual([]);
  });

  it('rejects unsupported ownership snapshot versions explicitly', () => {
    const source = createTestWorld({ seed: 27 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    grantAbilitySources(source, sourcePlayer, [
      {
        kind: 'active',
        abilityId: 'fireball',
        sourceId: learnedAbilityGrantSourceId('fireball'),
      },
    ]);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const invalidSnapshot = {
      ...snapshot,
      abilityState: {
        ...snapshot.abilityState!,
        grantOwnership: {
          ...snapshot.abilityState!.grantOwnership!,
          schemaVersion: 'ability-grant-ownership/v999',
        },
      },
    };
    const destination = createTestWorld({ seed: 27, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, invalidSnapshot)).toThrow(
      /unsupported ability grant ownership version/i,
    );
  });

  it('accumulates each completed floor once across capture and restore', () => {
    const source = createTestWorld({ seed: 42 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    initializeFloor1Scenario(source, sourcePlayer);
    source.floorScenario!.objective.ratsKilled = 5;
    source.floorScenario!.objective.slimesKilled = 2;
    source.floorScenario!.objective.goldCollected = 7;
    source.floorScenario!.runSummary = {
      outcome: 'cleared_floor',
      viewsEarned: 0,
      fansEarned: 0,
    };

    const firstSnapshot = capturePlayerCarryover(source, sourcePlayer);
    expect(firstSnapshot.achievements.carriedRunFacts?.numberFacts.totalKills).toBe(7);
    expect(firstSnapshot.achievements.carriedRunFacts?.reachedFloorIds).toEqual([1]);
    expect(firstSnapshot.achievements.carriedRunFacts?.clearedFloorIds).toEqual([1]);

    const destination = createTestWorld({ seed: 42, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    destination.floorId = 'floor2';
    restorePlayerCarryover(destination, destinationPlayer, firstSnapshot);
    const secondSnapshot = capturePlayerCarryover(destination, destinationPlayer);

    expect(secondSnapshot.achievements.carriedRunFacts?.numberFacts.totalKills).toBe(7);
    expect(secondSnapshot.achievements.carriedRunFacts?.numberFacts.goldCollected).toBe(7);
    expect(secondSnapshot.achievements.carriedRunFacts?.reachedFloorIds).toEqual([1, 2]);
    expect(secondSnapshot.achievements.carriedRunFacts?.clearedFloorIds).toEqual([1]);
  });

  it('migrates legacy carryover without scoped facts and preserves unlock state', () => {
    const source = createTestWorld({ seed: 42 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    source.achievements.unlockedIds.add('first-bonk');
    source.achievements.pendingUnlockIds.push('first-bonk');
    source.achievements.claimedIds.add('first-bonk');
    const currentSnapshot = capturePlayerCarryover(source, sourcePlayer);
    const legacySnapshot = {
      ...currentSnapshot,
      achievements: {
        unlockedIds: currentSnapshot.achievements.unlockedIds,
        pendingUnlockIds: currentSnapshot.achievements.pendingUnlockIds,
        claimedIds: currentSnapshot.achievements.claimedIds,
      },
    };
    const destination = createTestWorld({ seed: 42, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacySnapshot);

    expect(destination.achievements.unlockedIds).toEqual(new Set(['first-bonk']));
    expect(destination.achievements.pendingUnlockIds).toEqual(['first-bonk']);
    expect(destination.achievements.claimedIds).toEqual(new Set(['first-bonk']));
    expect(destination.achievements.carriedRunFacts).toEqual(createEmptyAchievementFactSnapshot());
  });

  it('starts a new run with no carried achievement facts', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    expect(world.achievements.carriedRunFacts).toEqual(createEmptyAchievementFactSnapshot());
  });

  it('migrates an unversioned static snapshot without changing static carryover', () => {
    const source = createTestWorld({ seed: 42 });
    const player = spawnPlayer(source, 0, 0);
    source.playerName = 'Legacy Static';
    const current = capturePlayerCarryover(source, player);
    const {
      schemaVersion: _schemaVersion,
      generatedInventoryInstanceKeys: _generatedInventoryInstanceKeys,
      generatedEquippedInstanceKeys: _generatedEquippedInstanceKeys,
      generatedEquipmentRegistry: _generatedEquipmentRegistry,
      generatedEquipmentRewardBundles: _generatedEquipmentRewardBundles,
      bossChests: _bossChests,
      lootBoxRewardBundles: _lootBoxRewardBundles,
      ...legacy
    } = current;
    const destination = createTestWorld({ seed: 42 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacy);

    expect(destination.playerName).toBe('Legacy Static');
    expect(destination.inventories.get(destinationPlayer)).toEqual(source.inventories.get(player));
  });

  it.each(['floor2-family-annihilator', 'floor2-floor-cleared', 'floor2-scorched-earth'] as const)(
    'restores the legacy tier4 reward bundle for %s',
    (achievementId) => {
      const runKey = `legacy-tier4-${achievementId}`;
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const bundled = createGeneratedEquipmentInstance(
        source,
        generatedEquipmentInput({
          baseId: `legacy.${achievementId}`,
          slots: ['feet'],
          rarity: 'rare',
        }),
      );
      source.achievements.unlockedIds.add(achievementId);
      source.generatedEquipmentRewardBundles.set(achievementId, {
        schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
        achievementId,
        tier: 'tier4',
        instanceKeys: [bundled.instanceId],
      });

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(
        destination,
        destinationPlayer,
        JSON.parse(JSON.stringify(capturePlayerCarryover(source, player))),
      );

      expect(destination.generatedEquipmentRewardBundles.get(achievementId)?.tier).toBe('tier4');
    },
  );

  it('still fails closed for a tier4 bundle on an achievement outside the legacy allowlist', () => {
    const runKey = 'invalid-tier4-nonlegacy';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const bundled = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({
        baseId: 'legacy.non-allowlisted',
        slots: ['feet'],
        rarity: 'rare',
      }),
    );
    source.achievements.unlockedIds.add('floor2-field-kit');
    source.generatedEquipmentRewardBundles.set('floor2-field-kit', {
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'floor2-field-kit',
      tier: 'tier4',
      instanceKeys: [bundled.instanceId],
    });

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    expect(() =>
      restorePlayerCarryover(
        destination,
        destinationPlayer,
        JSON.parse(JSON.stringify(capturePlayerCarryover(source, player))),
      ),
    ).toThrow(/tier tier4 does not match achievement tier tier1/);
  });

  it('round-trips exact generated ownership, bundles, grants, and frozen weapon behavior', () => {
    const runKey = 'carryover-generated-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const equipped = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({
        baseId: 'weapon.generated-carryover',
        slots: ['mainHand'],
        grants: true,
        weapon: true,
      }),
    );
    const bagged = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({ baseId: 'armor.generated-bag', slots: ['head'] }),
    );
    const bundledCommon = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({
        baseId: 'armor.generated-bundle',
        slots: ['feet'],
        rarity: 'common',
      }),
    );
    expect(addGeneratedEquipmentToBag(source, player, equipped.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        player,
        { kind: 'generated-instance', instanceKey: equipped.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    expect(addGeneratedEquipmentToBag(source, player, bagged.instanceId).ok).toBe(true);
    // A persisted reward bundle is only valid for a real, unlocked, unclaimed
    // tier1 equipment-reward achievement and must hold exactly one instance
    // whose rarity is a member of that tier's allowed pool (fail-closed
    // carryover contract — tier1 is common-only).
    source.achievements.unlockedIds.add('floor2-field-kit');
    source.generatedEquipmentRewardBundles.set('floor2-field-kit', {
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'floor2-field-kit',
      tier: 'tier1',
      instanceKeys: [bundledCommon.instanceId],
    });

    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    restorePlayerCarryover(destination, destinationPlayer, serialized);

    expect(snapshotGeneratedEquipmentRegistry(destination)).toEqual(
      snapshotGeneratedEquipmentRegistry(source),
    );
    const restoredGeneratedBag = destination.inventories.get(destinationPlayer);
    expect(
      restoredGeneratedBag ? listGeneratedEquipmentReferences(restoredGeneratedBag) : undefined,
    ).toEqual([{ kind: 'generated-instance', instanceKey: bagged.instanceId }]);
    expect(getEquipmentState(destination, destinationPlayer)?.equipped.mainHand).toBe(
      equipped.instanceId,
    );
    expect(getActiveWeaponDef(destination)).toEqual(equipped.frozen.activeWeaponSnapshot);
    expect(getActiveWeaponSnapshot(destination)).toEqual(equipped.frozen.activeWeaponSnapshot);
    expect(
      destination.abilityStatesByEntity.get(destinationPlayer)?.equippedActiveAbilityIds,
    ).toContain('magic-missile');
    expect(destination.abilityStatesByEntity.get(destinationPlayer)?.passiveAbilityIds).toContain(
      'combat-flow',
    );
    expect(
      destination.abilityStatesByEntity.get(destinationPlayer)?.activeAbilityGrantSources,
    ).toEqual(
      new Map([
        [
          'magic-missile',
          [
            {
              kind: 'generated-equipment',
              instanceId: equipped.instanceId,
              effectOrdinal: 0,
            },
          ],
        ],
      ]),
    );
    expect(
      destination.abilityStatesByEntity
        .get(destinationPlayer)
        ?.grantOwnership?.activeSourcesByAbilityId?.get('magic-missile'),
    ).toEqual(new Set([`equipment:${equipped.instanceId}:0`]));
    expect(destination.generatedEquipmentRewardBundles.get('floor2-field-kit')).toEqual({
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'floor2-field-kit',
      tier: 'tier1',
      instanceKeys: [bundledCommon.instanceId],
    });
    expect(
      Object.isFrozen(destination.generatedEquipmentRewardBundles.get('floor2-field-kit')),
    ).toBe(true);

    expect(unequip(destination, destinationPlayer, 'mainHand', { force: true }).ok).toBe(true);
    expect(getActiveWeaponDef(destination)).toBeUndefined();
    expect(
      destination.abilityStatesByEntity.get(destinationPlayer)?.equippedActiveAbilityIds,
    ).not.toContain('magic-missile');
    expect(
      destination.abilityStatesByEntity.get(destinationPlayer)?.passiveAbilityIds,
    ).not.toContain('combat-flow');
  });

  it('restores a "player-carryover/v1" snapshot captured before bossChests existed', () => {
    // Regression test: bossChests was added to the "player-carryover/v1" shape
    // without a schema-version bump (same pattern PR #1810 used for
    // generatedEquipmentRewardBundles). A snapshot serialized by a build
    // before bossChests existed still carries schemaVersion "player-carryover/v1"
    // and therefore matches the "current schema" branch of
    // normalizePlayerCarryoverSnapshot — it must default the missing field to
    // [] instead of hard-failing restore (multi-model code review round 1).
    const runKey = 'carryover-pre-bosschest-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    expect(Array.isArray(serialized.bossChests)).toBe(true);
    delete serialized.bossChests;

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).not.toThrow();
    expect(destination.bossChests.size).toBe(0);
  });

  it('still fails closed when a "player-carryover/v1" snapshot has an explicitly null bossChests', () => {
    // Regression test: the absent-field default must not swallow a
    // present-but-malformed value. Setting bossChests to null (rather than
    // omitting the key entirely) must still hit the assertArray guard and
    // throw, matching every other structural field (multi-model code review
    // round 2 — the initial `?? []` default treated null the same as
    // "missing" and silently accepted it).
    const runKey = 'carryover-null-bosschest-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = null;

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /Expected array at bossChests/,
    );
  });

  it('fails closed when a persisted boss chest has a non-string familyId', () => {
    // Regression test: familyId is interpolated into a template literal by
    // createBossChestId, which silently coerces a non-string to a string, so
    // a malformed numeric familyId can otherwise slip past the
    // chestId-derivation equality check undetected (multi-model code review
    // round 3).
    const runKey = 'carryover-bad-familyid-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      { chestId: 'boss-chest:5', familyId: 5, state: 'available', createdAtMs: 0 },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /Boss chest requires a string familyId/,
    );
  });

  it('fails closed when a persisted boss chest has a non-numeric createdAtMs', () => {
    const runKey = 'carryover-bad-createdatms-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'available',
        createdAtMs: undefined,
      },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /invalid createdAtMs/,
    );
  });

  it('fails closed when a persisted available boss chest stores only one spawn coordinate', () => {
    const runKey = 'carryover-bad-bosschest-spawn-pair-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'available',
        createdAtMs: 0,
        spawnX: 17,
      },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /must persist spawnX and spawnY together/,
    );
  });

  it('fails closed when a persisted available boss chest stores a non-finite spawn coordinate', () => {
    const runKey = 'carryover-bad-bosschest-spawn-value-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'available',
        createdAtMs: 0,
        spawnX: 'bad',
        spawnY: 29,
      },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /has an invalid spawn position/,
    );
  });

  it.each(['revealed', 'claimed'] as const)(
    'fails closed when a persisted boss chest is "%s" but has no revealedGrant',
    (state) => {
      // Regression test: `revealedGrant` is only ever populated on the real
      // available->revealed transition (openBossChest) and is never cleared
      // on revealed->claimed (acknowledgeBossChestReveal), so a persisted
      // "revealed"/"claimed" chest missing it can only be tampered/corrupt
      // data. Without this check, such a chest would silently pass
      // validation and then get stuck: every UI/resume path requires
      // revealedGrant to present or acknowledge it (round-2 code review).
      const runKey = `carryover-missing-revealedgrant-${state}-run`;
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
      serialized.bossChests = [
        { chestId: 'boss-chest:goblin-warband', familyId: 'goblin-warband', state, createdAtMs: 0 },
      ];

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);

      expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
        /has no revealedGrant/,
      );
    },
  );

  it('fails closed when a persisted boss chest revealedGrant is not tier4', () => {
    const runKey = 'carryover-bad-revealedgrant-tier-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'revealed',
        createdAtMs: 0,
        revealedGrant: {
          kind: 'equipment',
          tier: 'tier2',
          instanceKeys: ['gei:v1:carryover-bad-revealedgrant-tier-run:0'],
        },
      },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /must have tier "tier4"/,
    );
  });

  it('fails closed when a persisted boss chest revealedGrant has the wrong instance count', () => {
    const runKey = 'carryover-bad-revealedgrant-count-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [
      {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'revealed',
        createdAtMs: 0,
        revealedGrant: {
          kind: 'equipment',
          tier: 'tier4',
          instanceKeys: [
            'gei:v1:carryover-bad-revealedgrant-count-run:0',
            'gei:v1:carryover-bad-revealedgrant-count-run:1',
          ],
        },
      },
    ];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /must contain exactly 1 instance/,
    );
  });

  it('fails closed when a persisted boss chest revealedGrant has a dangling instance key', () => {
    const runKey = 'carryover-bad-revealedgrant-dangling-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const generated = createGeneratedEquipmentInstance(source, generatedEquipmentInput());
    expect(addGeneratedEquipmentToBag(source, player, generated.instanceId).ok).toBe(true);
    source.bossChests.set('boss-chest:goblin-warband', {
      chestId: 'boss-chest:goblin-warband',
      familyId: 'goblin-warband',
      state: 'revealed',
      createdAtMs: 0,
      revealedGrant: {
        kind: 'equipment',
        tier: 'tier4',
        instanceKeys: [generated.instanceId],
      },
    });
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as {
      bossChests: Array<{ chestId: string; revealedGrant?: { instanceKeys: string[] } }>;
    };
    serialized.bossChests[0]!.revealedGrant!.instanceKeys = [
      'gei:v1:carryover-bad-revealedgrant-dangling-run:999',
    ];
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /dangling instance key/,
    );
  });

  it('restores a "player-carryover/v1" snapshot missing generatedEquipmentRewardBundles', () => {
    // Regression test: the round-1 absent-key default was only applied to
    // bossChests, but generatedInventoryInstanceKeys, generatedEquippedInstanceKeys,
    // and generatedEquipmentRewardBundles were *also* added to the
    // "player-carryover/v1" shape without a schema-version bump (PR #1810), so
    // a pre-existing snapshot missing any of them hit the same hard-fail via
    // assertArray. Fixed by defaulting all four fields on true key-absence
    // (multi-model code review, round 4).
    const runKey = 'carryover-pre-bundles-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    expect(Array.isArray(serialized.generatedEquipmentRewardBundles)).toBe(true);
    delete serialized.generatedEquipmentRewardBundles;
    delete serialized.generatedInventoryInstanceKeys;
    delete serialized.generatedEquippedInstanceKeys;

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).not.toThrow();
    expect(destination.generatedEquipmentRewardBundles.size).toBe(0);
  });

  it('fails closed when a persisted boss chest entry is null', () => {
    // Regression test: assertArray only checks Array.isArray, so a malformed
    // array element (e.g. null) previously bypassed the fail-closed
    // PlayerCarryoverSnapshotError system entirely and threw a native
    // TypeError when the loop accessed `chest.familyId` (multi-model code
    // review, round 4).
    const runKey = 'carryover-null-chest-entry-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.bossChests = [null];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /Boss chest entry must be an object/,
    );
  });

  it('fails closed when a persisted generated reward bundle entry is null', () => {
    // Mirrors the boss-chest null-entry guard above for
    // generatedEquipmentRewardBundles (multi-model code review, round 4).
    const runKey = 'carryover-null-bundle-entry-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    serialized.generatedEquipmentRewardBundles = [null];

    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow(
      /Generated reward bundle entry must be an object/,
    );
  });

  it('retains independently owned grants after the last equipment source is removed', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'carryover-retained-grant-run',
    });
    const player = spawnPlayer(world, 0, 0);
    world.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: ['magic-missile'],
      ownedActiveAbilityIds: ['magic-missile'],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
      grantOwnership: {
        schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
        activeSourcesByAbilityId: new Map([['magic-missile', new Set(['learned:magic-missile'])]]),
        passiveSourcesByAbilityId: new Map(),
      },
    });
    const generated = createGeneratedEquipmentInstance(
      world,
      generatedEquipmentInput({ slots: ['head'], grants: true }),
    );
    expect(addGeneratedEquipmentToBag(world, player, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: generated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    const sourcesAfterEquip = world.abilityStatesByEntity
      .get(player)
      ?.grantOwnership?.activeSourcesByAbilityId?.get('magic-missile');
    expect(sourcesAfterEquip?.has('learned:magic-missile')).toBe(true);
    expect([...(sourcesAfterEquip ?? [])].some((source) => source.startsWith('equipment:'))).toBe(
      true,
    );

    expect(unequip(world, player, 'head', { force: true }).ok).toBe(true);
    expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toContain(
      'magic-missile',
    );
    expect(
      world.abilityStatesByEntity
        .get(player)
        ?.grantOwnership?.activeSourcesByAbilityId?.get('magic-missile'),
    ).toEqual(new Set(['learned:magic-missile']));
  });

  it('rejects a mismatched sourced-grant reference before mutation', () => {
    const runKey = 'carryover-grant-mismatch-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const generated = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({ slots: ['head'], grants: true }),
    );
    expect(addGeneratedEquipmentToBag(source, sourcePlayer, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        sourcePlayer,
        { kind: 'generated-instance', instanceKey: generated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const mismatched = {
      ...snapshot,
      abilityState: {
        ...snapshot.abilityState!,
        grantOwnership: {
          schemaVersion: snapshot.abilityState!.grantOwnership!.schemaVersion,
          activeSourcesByAbilityId: [['magic-missile', [`equipment:${generated.instanceId}:99`]]],
          passiveSourcesByAbilityId: [],
        },
      },
    };
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    destination.playerName = 'Unchanged';

    expect(() => restorePlayerCarryover(destination, destinationPlayer, mismatched)).toThrow(
      'Generated grant source mismatches magic-missile',
    );
    expect(destination.playerName).toBe('Unchanged');
  });

  it('preserves generated active abilities that were known-inactive before carryover replay', () => {
    const runKey = 'carryover-generated-active-order';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    for (const abilityId of [
      'fireball',
      'heal',
      'pulse-shield',
      'magic-missile',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
      'haste',
    ] as const) {
      memorizeSpell(source, player, abilityId);
    }

    const activeGenerated = createGeneratedEquipmentInstance(source, {
      baseId: 'accessory.carryover-active-generated',
      itemLevel: 3,
      rarity: 'uncommon',
      enhancementLevel: 0,
      resolvedEffects: [
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'carryover-battle-focus',
          effectOrdinal: 0,
          unitCost: 1,
          kind: 'abilityGrant',
          grantId: 'battle-focus',
        },
      ],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Carryover Battle Focus Charm',
        artKey: 'equipment.carryover-battle-focus',
        slots: ['offHand'],
        tags: ['equipment', 'carryover-test'],
        weightLb: 1,
        statBonuses: {},
        abilityGrants: ['battle-focus'],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
    const inactiveGenerated = createGeneratedEquipmentInstance(source, {
      baseId: 'armor.carryover-inactive-generated',
      itemLevel: 3,
      rarity: 'uncommon',
      enhancementLevel: 0,
      resolvedEffects: [
        {
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: 'carryover-frost-nova',
          effectOrdinal: 0,
          unitCost: 1,
          kind: 'abilityGrant',
          grantId: 'frost-nova',
        },
      ],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Carryover Frost Nova Coat',
        artKey: 'equipment.carryover-frost-nova',
        slots: ['chest'],
        tags: ['equipment', 'carryover-test'],
        weightLb: 4,
        statBonuses: {},
        abilityGrants: ['frost-nova'],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    });
    expect(addGeneratedEquipmentToBag(source, player, activeGenerated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        player,
        { kind: 'generated-instance', instanceKey: activeGenerated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    expect(addGeneratedEquipmentToBag(source, player, inactiveGenerated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        player,
        { kind: 'generated-instance', instanceKey: inactiveGenerated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    const sourceState = source.abilityStatesByEntity.get(player);
    expect(sourceState?.equippedActiveAbilityIds).toContain('battle-focus');
    expect(sourceState?.equippedActiveAbilityIds).not.toContain('frost-nova');
    expect(sourceState?.activeAbilityGrantSources?.get('battle-focus')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: activeGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);
    expect(sourceState?.activeAbilityGrantSources?.get('frost-nova')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: inactiveGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);

    const snapshot = capturePlayerCarryover(source, player);
    expect(snapshot.abilityState?.activeAbilityGrantSources).toEqual(
      expect.arrayContaining([
        [
          'battle-focus',
          [
            {
              kind: 'generated-equipment',
              instanceId: activeGenerated.instanceId,
              effectOrdinal: 0,
            },
          ],
        ],
        [
          'frost-nova',
          [
            {
              kind: 'generated-equipment',
              instanceId: inactiveGenerated.instanceId,
              effectOrdinal: 0,
            },
          ],
        ],
      ]),
    );
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, snapshot);

    const destinationState = destination.abilityStatesByEntity.get(destinationPlayer);
    expect(destinationState?.equippedActiveAbilityIds).toContain('battle-focus');
    expect(destinationState?.equippedActiveAbilityIds).not.toContain('frost-nova');
    expect(destinationState?.activeAbilityGrantSources?.get('battle-focus')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: activeGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);
    expect(destinationState?.activeAbilityGrantSources?.get('frost-nova')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: inactiveGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);
  });

  it('fails before mutation on invalid versions, duplicate owners, and dangling references', () => {
    const runKey = 'carryover-invalid-run';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const generated = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({ slots: ['head'] }),
    );
    expect(addGeneratedEquipmentToBag(source, sourcePlayer, generated.instanceId).ok).toBe(true);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const invalidInputs: readonly unknown[] = [
      { ...snapshot, schemaVersion: 'player-carryover/v999' },
      {
        ...snapshot,
        generatedEquippedInstanceKeys: [generated.instanceId],
      },
      {
        ...snapshot,
        generatedInventoryInstanceKeys: [
          'gei:v1:carryover-invalid-run:999' as GeneratedEquipmentInstanceKey,
        ],
      },
      {
        ...snapshot,
        generatedInventoryInstanceKeys: null,
      },
      // bundle.instanceKeys must be an array; a non-array value must fail closed.
      // Use a real, unlocked equipment achievement so validation reaches the
      // array guard rather than short-circuiting on the semantic checks.
      {
        ...snapshot,
        achievements: {
          ...snapshot.achievements,
          unlockedIds: [...snapshot.achievements.unlockedIds, 'floor2-field-kit'],
        },
        generatedEquipmentRewardBundles: [
          {
            schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
            achievementId: 'floor2-field-kit',
            instanceKeys: '',
          },
        ],
      },
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState,
          activeAbilityGrantSources: [['magic-missile', [{ kind: 'equipment', instanceId: 1 }]]],
          passiveAbilityGrantSources: [],
        },
      },
    ];

    for (const invalid of invalidInputs) {
      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      destination.playerName = 'Unchanged';

      expect(() => restorePlayerCarryover(destination, destinationPlayer, invalid)).toThrow();
      expect(destination.playerName).toBe('Unchanged');
      const restoredInvalidBag = destination.inventories.get(destinationPlayer);
      expect(
        restoredInvalidBag ? listGeneratedEquipmentReferences(restoredInvalidBag) : undefined,
      ).toEqual([]);
    }
  });

  it('fails before mutation on invalid generated active grant sources', () => {
    const runKey = 'carryover-invalid-generated-active-source';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const generated = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({
        baseId: 'armor.invalid-generated-active-source',
        slots: ['head'],
        grants: true,
      }),
    );
    expect(addGeneratedEquipmentToBag(source, sourcePlayer, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        sourcePlayer,
        { kind: 'generated-instance', instanceKey: generated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const abilityState = snapshot.abilityState;
    expect(abilityState?.activeAbilityGrantSources).toBeDefined();

    const invalidInputs: readonly unknown[] = [
      {
        ...snapshot,
        generatedInventoryInstanceKeys: [
          ...snapshot.generatedInventoryInstanceKeys,
          generated.instanceId,
        ],
        generatedEquippedInstanceKeys: snapshot.generatedEquippedInstanceKeys.filter(
          (key) => key !== generated.instanceId,
        ),
      },
      {
        ...snapshot,
        abilityState: {
          ...abilityState!,
          activeAbilityGrantSources: abilityState!.activeAbilityGrantSources!.map(
            ([abilityId, sources]) =>
              abilityId === 'magic-missile'
                ? ([
                    abilityId,
                    [
                      {
                        kind: 'generated-equipment',
                        instanceId: generated.instanceId,
                        effectOrdinal: 1,
                      },
                    ],
                  ] as const)
                : ([abilityId, sources] as const),
          ),
        },
      },
      {
        ...snapshot,
        abilityState: {
          ...abilityState!,
          activeAbilityGrantSources: [
            [
              'magic-missile',
              [
                {
                  kind: 'generated-equipment',
                  instanceId: generated.instanceId,
                  effectOrdinal: 0,
                },
                {
                  kind: 'generated-equipment',
                  instanceId: generated.instanceId,
                  effectOrdinal: 0,
                },
              ],
            ],
          ],
        },
      },
    ];

    for (const invalid of invalidInputs) {
      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      destination.playerName = 'Unchanged';

      expect(() => restorePlayerCarryover(destination, destinationPlayer, invalid)).toThrow();
      expect(destination.playerName).toBe('Unchanged');
      const restoredInvalidGrantBag = destination.inventories.get(destinationPlayer);
      expect(
        restoredInvalidGrantBag
          ? listGeneratedEquipmentReferences(restoredInvalidGrantBag)
          : undefined,
      ).toEqual([]);
    }
  });

  it('does not serialize passive ability modifiers that were only granted by generated equipment', () => {
    const runKey = 'carryover-passive-generated-filter';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const player = spawnPlayer(source, 0, 0);
    source.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: [],
      passiveAbilityIds: ['combat-flow'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(['combat-flow']),
      activeAbilityGrantSources: new Map(),
      passiveAbilityGrantSources: new Map([
        [
          'combat-flow',
          [
            {
              kind: 'generated-equipment',
              instanceId: 'gei:v1:carryover-passive-generated-filter:0',
              effectOrdinal: 0,
            },
          ],
        ],
      ]),
    });
    addStatModifier(source, {
      sourceType: 'ability',
      sourceId: `combat-flow:passive:${player}:0`,
      stat: 'damage',
      op: 'add',
      value: 2,
    });

    const snapshot = capturePlayerCarryover(source, player);
    expect(snapshot.persistentStatModifiers).not.toContainEqual(
      expect.objectContaining({
        sourceId: `combat-flow:passive:${player}:0`,
      }),
    );
  });

  it('does not re-emit abilityActivateFlash VFX for a general passive across a floor carryover round trip', () => {
    // Regression guard for a hypothesis raised in review: does restoring
    // carryover reset appliedPassiveAbilityIds (it does — persistentStatModifiers
    // deliberately excludes passive-ability modifiers, see the test above) in a
    // way that causes applyPassive() to re-fire VFX for every owned general
    // passive on every floor transition? It must not, because applyPassive()
    // only emits abilityActivateFlash for weapon-gated passives
    // (def.weaponPrerequisite !== undefined) — general passives get their
    // one-time unlock VFX from the level-5 skill milestone site instead.
    const source = createTestWorld({ seed: 4242 });
    const sourcePlayer = spawnPlayer(source, 0, 0);

    grantPassiveAbility(source, sourcePlayer, 'combat-flow');
    abilitySystem(source);
    expect(
      source.abilityStatesByEntity.get(sourcePlayer)?.appliedPassiveAbilityIds.has('combat-flow'),
    ).toBe(true);
    // First application (via abilitySystem's synchronizeAbilityPassives pass)
    // must not have emitted VFX for this no-prerequisite passive.
    expect(source.vfxEvents.filter((e) => e.kind === 'abilityActivateFlash')).toHaveLength(0);

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    // Confirmed exclusion: combat-flow's stat modifier is never carried as a
    // persistentStatModifier, so appliedPassiveAbilityIds is reset on restore.
    expect(snapshot.persistentStatModifiers).not.toContainEqual(
      expect.objectContaining({ sourceId: `combat-flow:passive:${sourcePlayer}:0` }),
    );

    const destination = createTestWorld({ seed: 4242, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    restorePlayerCarryover(destination, destinationPlayer, snapshot);
    // restorePlayerCarryover already runs one synchronizeAbilityPassives pass
    // internally; run the full system once more (mirroring a real floor tick)
    // to make sure no delayed/second-pass VFX slips through either.
    abilitySystem(destination);

    expect(
      destination.abilityStatesByEntity
        .get(destinationPlayer)
        ?.appliedPassiveAbilityIds.has('combat-flow'),
    ).toBe(true);
    expect(
      destination.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith(`combat-flow:passive:${destinationPlayer}:`),
      ),
    ).toHaveLength(2);
    expect(destination.vfxEvents.filter((e) => e.kind === 'abilityActivateFlash')).toHaveLength(0);
  });

  it('does not re-emit abilityActivateFlash VFX for a weapon-gated passive across carryover when loadout is unchanged', () => {
    const source = createTestWorld({ seed: 5252 });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const sword = getEquipmentDefForStarterWeapon('sword');
    expect(sword).toBeDefined();
    expect(equip(source, sourcePlayer, sword!, { force: true }).ok).toBe(true);

    const weaponPassiveId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword');
    expect(weaponPassiveId).toBeDefined();
    grantPassiveAbility(source, sourcePlayer, weaponPassiveId!);
    abilitySystem(source);
    expect(source.vfxEvents.filter((e) => e.kind === 'abilityActivateFlash')).toHaveLength(1);

    source.vfxEvents.length = 0;
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    const destination = createTestWorld({ seed: 5252, floor: 2 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    restorePlayerCarryover(destination, destinationPlayer, snapshot);
    // Mirror a real floor tick after restore to guard against delayed replay.
    abilitySystem(destination);

    expect(
      destination.abilityStatesByEntity
        .get(destinationPlayer)
        ?.appliedPassiveAbilityIds.has(weaponPassiveId!),
    ).toBe(true);
    expect(destination.vfxEvents.filter((e) => e.kind === 'abilityActivateFlash')).toHaveLength(0);
  });

  it('fails closed with PlayerCarryoverSnapshotError on malformed array-typed fields', () => {
    const source = createTestWorld({ seed: 42 });
    const player = spawnPlayer(source, 0, 0);
    const snapshot = capturePlayerCarryover(source, player);

    const invalidInputs: readonly unknown[] = [
      // Finding 3: playerSkills not an array
      { ...snapshot, playerSkills: null },
      { ...snapshot, playerSkills: {} },
      // Finding 3: persistentStatModifiers not an array
      { ...snapshot, persistentStatModifiers: null },
      { ...snapshot, persistentStatModifiers: {} },
      // Finding 1: achievements sub-fields not arrays
      { ...snapshot, achievements: { ...snapshot.achievements, unlockedIds: 5 } },
      { ...snapshot, achievements: { ...snapshot.achievements, unlockedIds: null } },
      {
        ...snapshot,
        achievements: { ...snapshot.achievements, pendingUnlockIds: 'not-an-array' },
      },
      { ...snapshot, achievements: { ...snapshot.achievements, claimedIds: {} } },
      // Finding 1: achievements itself is not a non-null object
      { ...snapshot, achievements: null },
      { ...snapshot, achievements: 'string' },
      // Finding 2: inventorySlots element is null
      { ...snapshot, inventorySlots: [null] },
      // Finding 2: inventorySlots element has non-string itemId
      { ...snapshot, inventorySlots: [{ itemId: 123, quantity: 1 }] },
      // Finding 2: inventorySlots element missing/wrong quantity
      { ...snapshot, inventorySlots: [{ itemId: 'sword', quantity: 'lots' }] },
      // Finding 2: disabledEquipmentSlots element is not a string
      { ...snapshot, disabledEquipmentSlots: [42] },
      { ...snapshot, disabledEquipmentSlots: [null] },
      // Finding 5: equippedItemIds element is not a string
      { ...snapshot, equippedItemIds: [42] },
      { ...snapshot, equippedItemIds: [null] },
    ];

    for (const invalid of invalidInputs) {
      const destination = createTestWorld({ seed: 42, floor: 2 });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      destination.playerName = 'Unchanged';
      expect(() => restorePlayerCarryover(destination, destinationPlayer, invalid)).toThrow(
        /Expected|must be|must contain/i,
      );
      expect(destination.playerName).toBe('Unchanged');
    }
  });

  it('fails closed with PlayerCarryoverSnapshotError on malformed ability grant-source entries', () => {
    const source = createTestWorld({ seed: 42 });
    const player = spawnPlayer(source, 0, 0);
    source.abilityStatesByEntity.set(player, {
      learnedSpellIds: ['fireball'],
      equippedActiveAbilityIds: ['fireball'],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    });
    const snapshot = capturePlayerCarryover(source, player);

    const invalidInputs: readonly unknown[] = [
      // Finding 4: null entry in activeAbilityGrantSources
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: [null],
          passiveAbilityGrantSources: [],
        },
      },
      // Finding 4: non-array entry (not a tuple)
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: ['not-a-tuple'],
          passiveAbilityGrantSources: [],
        },
      },
      // Finding 4: null sources within an entry
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: [['fireball', null]],
          passiveAbilityGrantSources: [],
        },
      },
      // Finding 4: null source object within the sources array
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: [['fireball', [null]]],
          passiveAbilityGrantSources: [],
        },
      },
      // Finding 4: null entry in passiveAbilityGrantSources
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: [],
          passiveAbilityGrantSources: [null],
        },
      },
      // Finding 4: null source in passive sources
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          activeAbilityGrantSources: [],
          passiveAbilityGrantSources: [['veteran-instinct', [null]]],
        },
      },
    ];

    for (const invalid of invalidInputs) {
      const destination = createTestWorld({ seed: 42, floor: 2 });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      destination.playerName = 'Unchanged';
      expect(() => restorePlayerCarryover(destination, destinationPlayer, invalid)).toThrow(
        /Malformed/,
      );
      expect(destination.playerName).toBe('Unchanged');
    }
  });

  it('fails closed with PlayerCarryoverSnapshotError on malformed grant-ownership source entries', () => {
    const runKey = 'carryover-malformed-grant-ownership';
    const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const sourcePlayer = spawnPlayer(source, 0, 0);
    const equipped = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({
        baseId: 'armor.malformed-grant-ownership',
        slots: ['head'],
        grants: true,
      }),
    );
    expect(addGeneratedEquipmentToBag(source, sourcePlayer, equipped.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        source,
        sourcePlayer,
        { kind: 'generated-instance', instanceKey: equipped.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);
    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    expect(snapshot.abilityState?.grantOwnership).toBeDefined();

    const invalidInputs: readonly unknown[] = [
      // Finding 4 (grantOwnership): null entry in activeSourcesByAbilityId
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          grantOwnership: {
            ...snapshot.abilityState!.grantOwnership!,
            activeSourcesByAbilityId: [null],
          },
        },
      },
      // Finding 4 (grantOwnership): non-array sources in an entry
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          grantOwnership: {
            ...snapshot.abilityState!.grantOwnership!,
            activeSourcesByAbilityId: [['magic-missile', null]],
          },
        },
      },
      // Finding 4 (grantOwnership): null entry in passiveSourcesByAbilityId
      {
        ...snapshot,
        abilityState: {
          ...snapshot.abilityState!,
          grantOwnership: {
            ...snapshot.abilityState!.grantOwnership!,
            passiveSourcesByAbilityId: [null],
          },
        },
      },
    ];

    for (const invalid of invalidInputs) {
      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      destination.playerName = 'Unchanged';
      expect(() => restorePlayerCarryover(destination, destinationPlayer, invalid)).toThrow(
        'Malformed grant ownership source entry',
      );
      expect(destination.playerName).toBe('Unchanged');
    }
  });

  describe('reward-opening presentation persistence (save/load-safe redisplay)', () => {
    it('round-trips an achievement pendingPresentations entry through a JSON save/load cycle', () => {
      // Reward-opening UX hard requirement: a resolved-but-not-yet-acknowledged
      // presentation must survive a reload byte-for-byte so the UI can redisplay
      // the exact same reveal — never re-rolling or mutating the canonical grant.
      const runKey = 'carryover-reward-presentation-run';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      source.achievements.unlockedIds.add('first-bonk');
      source.achievements.claimedIds.add('first-bonk');
      source.achievements.pendingPresentations.set('first-bonk', {
        kind: 'lootBox',
        tier: 'trash',
        gold: 25,
        materials: ['floor1-common-scrap', 'floor1-common-scrap'],
      });
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(destination, destinationPlayer, serialized);

      expect(destination.achievements.pendingPresentations.get('first-bonk')).toEqual({
        kind: 'lootBox',
        tier: 'trash',
        gold: 25,
        materials: ['floor1-common-scrap', 'floor1-common-scrap'],
      });
    });

    it.each([
      'floor2-family-annihilator',
      'floor2-floor-cleared',
      'floor2-scorched-earth',
    ] as const)('restores the legacy pending tier4 presentation for %s', (achievementId) => {
      const runKey = `legacy-tier4-presentation-${achievementId}`;
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const generated = createGeneratedEquipmentInstance(
        source,
        generatedEquipmentInput({
          baseId: `legacy-presentation.${achievementId}`,
          slots: ['feet'],
          rarity: 'rare',
        }),
      );
      expect(addGeneratedEquipmentToBag(source, player, generated.instanceId).ok).toBe(true);
      source.achievements.unlockedIds.add(achievementId);
      source.achievements.claimedIds.add(achievementId);
      source.achievements.pendingPresentations.set(achievementId, {
        kind: 'equipment',
        tier: 'tier4',
        instanceKeys: [generated.instanceId],
      });

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(
        destination,
        destinationPlayer,
        JSON.parse(JSON.stringify(capturePlayerCarryover(source, player))),
      );

      expect(destination.achievements.pendingPresentations.get(achievementId)).toEqual({
        kind: 'equipment',
        tier: 'tier4',
        instanceKeys: [generated.instanceId],
      });
    });

    it('rejects a pending tier4 presentation outside the legacy allowlist', () => {
      const runKey = 'invalid-tier4-presentation';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const generated = createGeneratedEquipmentInstance(
        source,
        generatedEquipmentInput({
          baseId: 'legacy-presentation.non-allowlisted',
          slots: ['feet'],
          rarity: 'rare',
        }),
      );
      expect(addGeneratedEquipmentToBag(source, player, generated.instanceId).ok).toBe(true);
      source.achievements.unlockedIds.add('floor2-field-kit');
      source.achievements.claimedIds.add('floor2-field-kit');
      source.achievements.pendingPresentations.set('floor2-field-kit', {
        kind: 'equipment',
        tier: 'tier4',
        instanceKeys: [generated.instanceId],
      });

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      expect(() =>
        restorePlayerCarryover(
          destination,
          destinationPlayer,
          JSON.parse(JSON.stringify(capturePlayerCarryover(source, player))),
        ),
      ).toThrow(/has tier "tier4", expected "tier1"/);
    });

    it('round-trips a boss chest revealedGrant through a JSON save/load cycle without mutating it', () => {
      const runKey = 'carryover-bosschest-reveal-run';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const generated = createGeneratedEquipmentInstance(
        source,
        generatedEquipmentInput({ baseId: 'armor.bosschest-reveal', rarity: 'common' }),
      );
      expect(addGeneratedEquipmentToBag(source, player, generated.instanceId).ok).toBe(true);
      const instanceKeys: readonly GeneratedEquipmentInstanceKey[] = [generated.instanceId];
      source.bossChests.set('boss-chest:goblin-warband', {
        chestId: 'boss-chest:goblin-warband',
        familyId: 'goblin-warband',
        state: 'revealed',
        createdAtMs: 123,
        revealedGrant: { kind: 'equipment', tier: 'tier4', instanceKeys },
      });
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(destination, destinationPlayer, serialized);

      const restoredChest = destination.bossChests.get('boss-chest:goblin-warband');
      expect(restoredChest?.state).toBe('revealed');
      expect(restoredChest?.revealedGrant).toEqual({
        kind: 'equipment',
        tier: 'tier4',
        instanceKeys,
      });
    });

    it('round-trips an available boss chest physical spawn position through carryover restore', () => {
      const runKey = 'carryover-bosschest-position-run';
      const chestId = 'boss-chest:goblin-warband';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const chestEid = spawnBossChestEntity(source, 17, 29, chestId);
      resolveEquipmentRewardBundle(
        source,
        chestId,
        ['weapon.iron-cleaver', 'weapon.ember-wand'],
        'tier4',
      );
      const created = createBossChestRecord(source, chestId, 'goblin-warband');
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      source.bossChests.set(chestId, { ...created.chest, createdAtMs: 123 });

      const snapshot = capturePlayerCarryover(source, player);
      expect(snapshot.bossChests).toContainEqual({
        chestId,
        familyId: 'goblin-warband',
        state: 'available',
        createdAtMs: 123,
        spawnX: 17,
        spawnY: 29,
      });
      expect(source.bossChestEids.get(chestId)).toBe(chestEid);

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(
        destination,
        destinationPlayer,
        JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>,
      );

      const restoredChest = destination.bossChests.get(chestId);
      const restoredEid = destination.bossChestEids.get(chestId);
      expect(restoredChest?.state).toBe('available');
      expect(restoredEid).toBeDefined();
      if (restoredEid === undefined) return;
      expect(entityExists(destination.ecs, restoredEid)).toBe(true);
      expect(destination.stores.position.x[restoredEid]).toBe(17);
      expect(destination.stores.position.y[restoredEid]).toBe(29);
    });

    it('restores a "player-carryover/v1" snapshot missing achievements.pendingPresentations (pre-existing field)', () => {
      // pendingPresentations was added to the "player-carryover/v1" shape
      // without a schema-version bump (same pattern as bossChests/
      // generatedEquipmentRewardBundles). A snapshot serialized before this
      // field existed must default to an empty map, not hard-fail restore.
      const runKey = 'carryover-pre-presentations-run';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as {
        achievements: Record<string, unknown>;
      };
      expect(Array.isArray(serialized.achievements.pendingPresentations)).toBe(true);
      delete serialized.achievements.pendingPresentations;

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);

      expect(() =>
        restorePlayerCarryover(destination, destinationPlayer, serialized),
      ).not.toThrow();
      expect(destination.achievements.pendingPresentations.size).toBe(0);
    });

    it('fails closed when a persisted pendingPresentations entry is malformed', () => {
      const runKey = 'carryover-bad-presentation-run';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as {
        achievements: Record<string, unknown>;
      };
      serialized.achievements.pendingPresentations = [['first-bonk', { kind: 'notAKind' }]];

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);

      expect(() => restorePlayerCarryover(destination, destinationPlayer, serialized)).toThrow();
    });

    it('acknowledging a redisplayed boss chest reveal after reload is exact-once (no re-grant)', () => {
      // Cross-checks the presentation-never-mutates-canon requirement: redisplay
      // via a restored revealedGrant must never re-invoke the reward-granting
      // claim path. We assert the restored chest carries its `revealed` state
      // and grant snapshot forward untouched — the caller acknowledges via
      // `acknowledgeBossChestReveal`, a separate lifecycle transition that never
      // re-derives or re-rolls the grant.
      const runKey = 'carryover-bosschest-exactonce-run';
      const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(source, 0, 0);
      const generated = createGeneratedEquipmentInstance(
        source,
        generatedEquipmentInput({ baseId: 'armor.bosschest-exactonce', rarity: 'common' }),
      );
      expect(addGeneratedEquipmentToBag(source, player, generated.instanceId).ok).toBe(true);
      const instanceKeys: readonly GeneratedEquipmentInstanceKey[] = [generated.instanceId];
      const grant = { kind: 'equipment' as const, tier: 'tier4' as const, instanceKeys };
      source.bossChests.set('boss-chest:rat-swarm', {
        chestId: 'boss-chest:rat-swarm',
        familyId: 'rat-swarm',
        state: 'revealed',
        createdAtMs: 0,
        revealedGrant: grant,
      });
      const snapshot = capturePlayerCarryover(source, player);
      const serialized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

      const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      const destinationPlayer = spawnPlayer(destination, 0, 0);
      restorePlayerCarryover(destination, destinationPlayer, serialized);

      const restoredChest = destination.bossChests.get('boss-chest:rat-swarm');
      expect(restoredChest?.state).toBe('revealed');
      expect(restoredChest?.revealedGrant).toEqual(grant);
      // Redisplay must not have advanced the lifecycle state on its own.
      expect(restoredChest?.state).not.toBe('claimed');
    });
  });
});
