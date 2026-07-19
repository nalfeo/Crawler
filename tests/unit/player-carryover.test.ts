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
import {
  getEquipmentDefForStarterWeapon,
  MERCHANTS_CHARM_DEF,
} from '../../src/shared/equipmentDefs.js';
import {
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
  type GeneratedEquipmentInstanceKey,
} from '../../src/shared/generated-equipment-types.js';
import {
  createGeneratedEquipmentInstance,
  snapshotGeneratedEquipmentRegistry,
} from '../../src/core/generated-equipment-registry.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
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
    });
    source.frameCount = 1000;
    source.featureUnlocks = { inventory: true, equipment: true, spells: true };
    source.achievements.unlockedIds.add('first-blood');
    source.achievements.pendingUnlockIds.push('first-blood');
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

  it('round-trips exact generated ownership, grants, bundles, and frozen weapon behavior', () => {
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
    const {
      schemaVersion: _weaponSchemaVersion,
      sourceWeaponDefId: _sourceWeaponDefId,
      ...frozenWeapon
    } = equipped.frozen.activeWeaponSnapshot!;
    expect(getActiveWeaponDef(destination)).toEqual({
      ...frozenWeapon,
      id: equipped.instanceId,
    });
    expect(
      destination.abilityStatesByEntity.get(destinationPlayer)?.activeEquipmentGrantOwnershipById,
    ).toEqual(
      new Map([
        [
          'magic-missile',
          {
            retainedWithoutEquipment: false,
            sourceIds: new Set([`equipment:${equipped.instanceId}:0`]),
          },
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

  it('retains independently owned grants after the last equipment source is removed', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'carryover-retained-grant-run',
    });
    const player = spawnPlayer(world, 0, 0);
    world.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: ['magic-missile'],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
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
    expect(
      world.abilityStatesByEntity
        .get(player)
        ?.activeEquipmentGrantOwnershipById?.get('magic-missile')?.retainedWithoutEquipment,
    ).toBe(true);

    expect(unequip(world, player, 'head', { force: true }).ok).toBe(true);
    expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toContain(
      'magic-missile',
    );
    expect(world.abilityStatesByEntity.get(player)?.activeEquipmentGrantOwnershipById?.size).toBe(
      0,
    );
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
        activeEquipmentGrantOwnershipById: [
          [
            'magic-missile',
            {
              retainedWithoutEquipment: false,
              sourceIds: [`equipment:${generated.instanceId}:99`],
            },
          ],
        ],
      },
    };
    const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
    const destinationPlayer = spawnPlayer(destination, 0, 0);
    destination.playerName = 'Unchanged';

    expect(() => restorePlayerCarryover(destination, destinationPlayer, mismatched)).toThrow(
      'Dangling or mismatched generated grant source',
    );
    expect(destination.playerName).toBe('Unchanged');
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
});
