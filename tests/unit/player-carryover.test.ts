import { describe, expect, it } from 'vitest';
import { addEntity } from 'bitecs';
import { spawnPlayer } from '../../src/core/helpers.js';
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
import { memorizeSpell } from '../../src/game/systems/abilitySystem.js';
import { createEmptyAchievementFactSnapshot } from '../../src/shared/achievements.js';
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
import { createTestWorld } from '../helpers/world-factory.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';

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
    source.inventories.get(sourcePlayer)!.slots.push({
      itemId: 'throwing-knife',
      quantity: 3,
    });
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
      activeAbilityGrantSources: new Map([['fireball', [{ kind: 'learned' }]]]),
      passiveAbilityGrantSources: new Map(),
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
      ...legacy
    } = current;
    const destination = createTestWorld({ seed: 42 });
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacy);

    expect(destination.playerName).toBe('Legacy Static');
    expect(destination.inventories.get(destinationPlayer)).toEqual(source.inventories.get(player));
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
    const bundled = createGeneratedEquipmentInstance(
      source,
      generatedEquipmentInput({ baseId: 'armor.generated-bundle', slots: ['feet'] }),
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
    source.generatedEquipmentRewardBundles.set('carryover-reward', {
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'carryover-reward',
      instanceKeys: [bundled.instanceId],
    });

    const snapshot = capturePlayerCarryover(source, player);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    restorePlayerCarryover(destination, destinationPlayer, serialized);

    expect(snapshotGeneratedEquipmentRegistry(destination)).toEqual(
      snapshotGeneratedEquipmentRegistry(source),
    );
    expect(destination.inventories.get(destinationPlayer)?.generatedEquipment).toEqual([
      { kind: 'generated-instance', instanceKey: bagged.instanceId },
    ]);
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
    expect(destination.generatedEquipmentRewardBundles.get('carryover-reward')).toEqual({
      schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
      achievementId: 'carryover-reward',
      instanceKeys: [bundled.instanceId],
    });
    expect(
      Object.isFrozen(destination.generatedEquipmentRewardBundles.get('carryover-reward')),
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
    expect(sourceState?.activeAbilityGrantSources.get('battle-focus')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: activeGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);
    expect(sourceState?.activeAbilityGrantSources.get('frost-nova')).toEqual([
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
    expect(destinationState?.activeAbilityGrantSources.get('battle-focus')).toEqual([
      {
        kind: 'generated-equipment',
        instanceId: activeGenerated.instanceId,
        effectOrdinal: 0,
      },
    ]);
    expect(destinationState?.activeAbilityGrantSources.get('frost-nova')).toEqual([
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
      // bundle.instanceKeys must be an array; a non-array value must fail closed
      {
        ...snapshot,
        generatedEquipmentRewardBundles: [
          {
            schemaVersion: GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
            achievementId: 'test-bundle',
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
      expect(destination.inventories.get(destinationPlayer)?.generatedEquipment).toBeUndefined();
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
});
