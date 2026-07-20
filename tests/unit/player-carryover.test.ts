import { describe, expect, it } from 'vitest';
import { addEntity } from 'bitecs';
import { spawnPlayer } from '../../src/core/helpers.js';
import { equip, getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { addStatModifier } from '../../src/game/systems/statsSystem.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createEmptyAchievementFactSnapshot } from '../../src/shared/achievements.js';
import {
  abilitySystem,
  grantAbilitySources,
  normalizeAbilityState,
} from '../../src/game/systems/abilitySystem.js';
import {
  learnedAbilityGrantSourceId,
  skillAbilityGrantSourceId,
} from '../../src/shared/abilities.js';
import {
  getEquipmentDefForStarterWeapon,
  MERCHANTS_CHARM_DEF,
} from '../../src/shared/equipmentDefs.js';
import { addGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import type { GeneratedEquipmentInstanceKey } from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

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
<<<<<<< HEAD
=======
    source.achievements.carriedRunFacts = {
      ...source.achievements.carriedRunFacts,
      numberFacts: { ...source.achievements.carriedRunFacts.numberFacts, totalKills: 99 },
      booleanFacts: {
        ...source.achievements.carriedRunFacts.booleanFacts,
        staircaseUnlocked: true,
      },
      completedQuestIds: ['floor1-find-welcome'],
    };
>>>>>>> origin/main
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
<<<<<<< HEAD
=======
    expect(destination.achievements.carriedRunFacts.numberFacts.totalKills).toBe(99);
    expect(destination.achievements.carriedRunFacts.booleanFacts.staircaseUnlocked).toBe(true);
    expect(destination.achievements.carriedRunFacts.completedQuestIds).toContain(
      'floor1-find-welcome',
    );
>>>>>>> origin/main
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

<<<<<<< HEAD
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
      },
    };
    const destination = createTestWorld({ seed: 17, floor: 2 });
=======
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
>>>>>>> origin/main
    const destinationPlayer = spawnPlayer(destination, 0, 0);

    restorePlayerCarryover(destination, destinationPlayer, legacySnapshot);

<<<<<<< HEAD
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
=======
    expect(destination.achievements.unlockedIds).toEqual(new Set(['first-bonk']));
    expect(destination.achievements.pendingUnlockIds).toEqual(['first-bonk']);
    expect(destination.achievements.claimedIds).toEqual(new Set(['first-bonk']));
    expect(destination.achievements.carriedRunFacts).toEqual(createEmptyAchievementFactSnapshot());
  });

  it('starts a new run with no carried achievement facts', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    expect(world.achievements.carriedRunFacts).toEqual(createEmptyAchievementFactSnapshot());
>>>>>>> origin/main
  });

  it('fails closed instead of silently dropping generated bag ownership before B3', () => {
    const source = createTestWorld({ seed: 42 });
    const player = spawnPlayer(source, 0, 0);
    const bag = source.inventories.get(player)!;
    const instanceKey = 'gei:v1:carryover-test:0' as GeneratedEquipmentInstanceKey;
    addGeneratedEquipmentReference(bag, instanceKey);
    const bagBefore = structuredClone(bag);

    expect(() => capturePlayerCarryover(source, player)).toThrow(
      'Generated equipment carryover is not supported until the B3 persistence slice lands',
    );
    expect(bag).toEqual(bagBefore);
  });
});
