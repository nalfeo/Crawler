import { removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  getShopkeeperStage,
  initializeFloor1Scenario,
  meetSpellQuestGiver,
  meetTutorialGoon,
  meetShopkeeper,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectFloor1StarterWeapon,
  selectSpellFromBossBattle,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../../src/game/floor1Scenario.js';
import { getActiveWeapon } from '../../src/game/weaponSystem.js';
import { isQuestComplete, questSystem } from '../../src/core/systems/questSystem.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { addItem, hasItem } from '../../src/shared/inventory.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
} from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('floor1Scenario', () => {
  it('initializes Floor 1 into loadout state with deterministic starter choices', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);

    initializeFloor1Scenario(world, player);

    expect(world.state).toBe('loadout');
    expect(world.floorMap).not.toBeNull();
    expect(world.floor1).not.toBeNull();
    expect(world.floor1?.protagonistName).toBe('Rhea Vale');
    expect(world.floor1?.starterChoices).toHaveLength(3);
    expect(new Set(world.floor1?.starterChoices ?? []).size).toBe(3);
  });

  it('applies selected starter weapon and transitions to playing', () => {
    const world = createTestWorld({ seed: 14 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    const chosenId = world.floor1?.starterChoices[1];
    selectFloor1StarterWeapon(world, 1);

    expect(world.state).toBe('playing');
    expect(world.floor1?.selectedWeaponId).toBe(chosenId);
    expect(getActiveWeapon(world)?.id).toBe(chosenId);
  });

  it('times out the run when the staircase deadline is missed', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const deadlineMs = world.floor1?.objective.deadlineMs ?? 0;
    world.elapsedMs = deadlineMs + 1;
    floorObjectiveSystem(world);

    expect(world.state).toBe('game_over');
    expect(world.floor1?.failReason).toBe('stair_timeout');
    expect(world.floor1?.runSummary?.outcome).toBe('failed_timeout');
  });

  it('spawns deterministic rat/slime encounters from the floor director', () => {
    const worldA = createTestWorld({ seed: 99 });
    const worldB = createTestWorld({ seed: 99 });
    const playerA = spawnPlayer(worldA, 0, 0);
    const playerB = spawnPlayer(worldB, 0, 0);
    initializeFloor1Scenario(worldA, playerA);
    initializeFloor1Scenario(worldB, playerB);
    selectFloor1StarterWeapon(worldA, 0);
    selectFloor1StarterWeapon(worldB, 0);

    worldA.elapsedMs = 1000;
    worldB.elapsedMs = 1000;
    floor1EnemyDirectorSystem(worldA);
    floor1EnemyDirectorSystem(worldB);

    const spawnedA = [...(worldA.floor1?.enemyArchetypes.entries() ?? [])][0];
    const spawnedB = [...(worldB.floor1?.enemyArchetypes.entries() ?? [])][0];

    expect(spawnedA).toBeDefined();
    expect(spawnedB).toBeDefined();

    if (!spawnedA || !spawnedB) {
      throw new Error('Expected both worlds to spawn a floor1 enemy');
    }

    const [eidA, archetypeA] = spawnedA;
    const [eidB, archetypeB] = spawnedB;
    expect(archetypeA).toBe(archetypeB);
    expect(worldA.stores.position.x[eidA]).toBeCloseTo(worldB.stores.position.x[eidB] ?? 0, 5);
    expect(worldA.stores.position.y[eidA]).toBeCloseTo(worldB.stores.position.y[eidB] ?? 0, 5);
  });

  it('runs Slime Rat boss first, then staircase Rat Slime boss', () => {
    const world = createTestWorld({ seed: 123 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const objective = world.floor1?.objective;
    if (!objective) {
      throw new Error('Expected floor1 objective to exist');
    }

    objective.ratsKilled = objective.requiredRats;
    objective.slimesKilled = objective.requiredSlimes;
    expect(objective.bossBattleStarted).toBe(false);
    expect(objective.staircaseBossEid).toBeNull();
    expect(objective.staircaseSpawned).toBe(false);
    expect(objective.staircaseLocked).toBe(true);
    expect(objective.staircaseUnlocked).toBe(false);

    // Kills do not complete boss-unlock until level quest completion unlocks it.
    world.elapsedMs = 1_000;
    floorObjectiveSystem(world);
    expect(objective.questCompleted).toBe(false);

    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    floorObjectiveSystem(world);
    questSystem(world);
    floorObjectiveSystem(world);

    expect(world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);
    expect(world.goalFlags.get('floor1-leveling-quest-complete')).toBe(true);
    expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(true);
    floorObjectiveSystem(world);
    expect(objective.questCompleted).toBe(true);
    expect(objective.staircaseBossEid).toBeNull();
    meetSpellQuestGiver(world);

    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);
    expect(objective.slimeRatBattleStarted).toBe(true);
    if (world.floor1 && world.floor1.slimeRatDoorEids.length > 0) {
      for (const doorEid of world.floor1.slimeRatDoorEids) {
        expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      }
    }
    const slimeRatBossEid = objective.slimeRatBossEid;
    if (slimeRatBossEid === null) {
      throw new Error('Expected Slime Rat boss to exist');
    }
    removeEntity(world.ecs, slimeRatBossEid);
    floorObjectiveSystem(world);
    expect(objective.slimeRatBossDefeated).toBe(true);
    if (world.floor1 && world.floor1.slimeRatDoorEids.length > 0) {
      for (const doorEid of world.floor1.slimeRatDoorEids) {
        expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
      }
    }
    expect(world.goalFlags.get('floor1-boss-battle-complete')).toBe(false);
    meetSpellQuestGiver(world);
    questSystem(world);
    expect(world.goalFlags.get('floor1-boss-battle-complete')).toBe(true);

    world.stores.position.x[player] = objective.staircasePos.x;
    world.stores.position.y[player] = objective.staircasePos.y;
    floorObjectiveSystem(world);
    expect(objective.bossBattleStarted).toBe(true);
    expect(objective.staircaseDiscovered).toBe(false);

    const bossEid = objective.staircaseBossEid;
    if (bossEid === null) {
      throw new Error('Expected staircase boss to exist');
    }

    removeEntity(world.ecs, bossEid);
    floorObjectiveSystem(world);
    expect(objective.staircaseSpawned).toBe(true);
    expect(objective.staircaseLocked).toBe(false);
    expect(objective.staircaseUnlocked).toBe(true);
    expect(objective.staircaseBossDefeated).toBe(true);

    const descended = confirmFloor1StairDescend(world, player);
    expect(descended).toBe(true);
    expect(objective.staircaseDiscovered).toBe(true);
    expect(world.state).toBe('safe_room');
    expect(world.floor1?.runSummary?.outcome).toBe('cleared_floor');
  });

  it('starts Slime Rat battle from spell quest acceptance without goon combat completion', () => {
    const world = createTestWorld({ seed: 321 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const objective = world.floor1?.objective;
    if (!objective) {
      throw new Error('Expected floor1 objective to exist');
    }

    expect(objective.questCompleted).toBe(false);
    meetSpellQuestGiver(world);
    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);

    expect(objective.slimeRatBattleStarted).toBe(true);
    expect(objective.slimeRatBossEid).not.toBeNull();
    if (world.floor1 && world.floor1.slimeRatDoorEids.length > 0) {
      for (const doorEid of world.floor1.slimeRatDoorEids) {
        expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      }
    }
  });

  it('only allows the three boss-reward spells and unlocks abilities after a valid pick', () => {
    const makeWorld = () => {
      const world = createTestWorld({ seed: 123 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      world.goalFlags.set('floor1-boss-battle-complete', true);
      return { world, player };
    };

    const validSpells = ['fireball', 'heal', 'pulse-shield'] as const;
    for (const spellId of validSpells) {
      const { world, player } = makeWorld();
      const learned = selectSpellFromBossBattle(world, player, spellId);
      expect(learned).toBe(true);
      expect(world.featureUnlocks.spells).toBe(true);
      expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toContain(spellId);
    }

    const { world: invalidWorld, player: invalidPlayer } = makeWorld();
    const rejected = selectSpellFromBossBattle(invalidWorld, invalidPlayer, 'arcane-bolt');
    expect(rejected).toBe(false);
    expect(invalidWorld.featureUnlocks.spells).toBe(false);
    expect(invalidWorld.abilityStatesByEntity.get(invalidPlayer)).toBeUndefined();
  });

  describe('shopkeeper errand questline', () => {
    it('waits to accept NPC quests until you meet the NPC', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      expect(world.questLog.has(FLOOR1_SHOP_QUEST_ID)).toBe(false);
      expect(world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);
      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);
      expect(getShopkeeperStage(world)).toBe('not-met');
      expect(world.featureUnlocks.inventory).toBe(false);
      expect(world.featureUnlocks.equipment).toBe(false);

      meetShopkeeper(world);
      questSystem(world);
      expect(world.questLog.has(FLOOR1_SHOP_QUEST_ID)).toBe(true);
      expect(getShopkeeperStage(world)).toBe('awaiting-prize');
    });

    it('walks the merchant errand: meet → fetch → return → buy → equip', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      world.playerGold = SHOPKEEPER_EQUIPMENT_COST + 10;
      const bag = world.inventories.get(player)!;

      // Meet the merchant.
      meetShopkeeper(world);
      questSystem(world);
      expect(getShopkeeperStage(world)).toBe('awaiting-prize');

      // Pick up the gross fetch item → inventory unlocks.
      addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
      questSystem(world);
      expect(world.featureUnlocks.inventory).toBe(true);

      // Return the prize: consumes the item, opens the shop.
      expect(returnShopkeeperPrize(world, player)).toBe(true);
      expect(hasItem(bag, SHOPKEEPER_FETCH_ITEM_ID)).toBe(false);
      questSystem(world);
      expect(getShopkeeperStage(world)).toBe('ready-to-buy');

      // Buy the charm → gold deducted, equipment unlocks.
      const goldBefore = world.playerGold;
      expect(purchaseShopkeeperEquipment(world, player)).toBe(true);
      expect(world.playerGold).toBe(goldBefore - SHOPKEEPER_EQUIPMENT_COST);
      expect(hasItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID)).toBe(true);
      questSystem(world);
      expect(world.featureUnlocks.equipment).toBe(true);
      expect(getShopkeeperStage(world)).toBe('awaiting-equip');

      // Equip the charm → quest completes.
      expect(equipPurchasedGear(world, player)).toBe(true);
      questSystem(world);
      expect(getShopkeeperStage(world)).toBe('complete');
      expect(isQuestComplete(world, FLOOR1_SHOP_QUEST_ID)).toBe(true);
    });

    it('refuses to sell when the player cannot afford the charm', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      const bag = world.inventories.get(player)!;
      world.playerGold = SHOPKEEPER_EQUIPMENT_COST - 1;

      meetShopkeeper(world);
      addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
      returnShopkeeperPrize(world, player);

      expect(purchaseShopkeeperEquipment(world, player)).toBe(false);
      expect(hasItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID)).toBe(false);
      expect(world.playerGold).toBe(SHOPKEEPER_EQUIPMENT_COST - 1);
    });

    it('does not let the player return a prize they do not hold', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      meetShopkeeper(world);

      expect(returnShopkeeperPrize(world, player)).toBe(false);
      expect(world.goalFlags.get('floor1-shop-prize-returned')).not.toBe(true);
    });

    it('unlocks the boss-door quest only after completing the level-2 quest', () => {
      const world = createTestWorld({ seed: 123 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const objective = world.floor1?.objective;
      if (!objective) {
        throw new Error('Expected floor1 objective to exist');
      }
      objective.ratsKilled = objective.requiredRats;
      objective.slimesKilled = objective.requiredSlimes;
      world.elapsedMs = 1_000;
      floorObjectiveSystem(world);

      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);
      meetTutorialGoon(world);
      floorObjectiveSystem(world);
      questSystem(world);
      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);

      world.playerLevel.level = 2;
      floorObjectiveSystem(world);
      questSystem(world);
      floorObjectiveSystem(world);
      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(true);
      expect(objective.questCompleted).toBe(true);
      // Boss-unlock QUEST acceptance + kill-completion stay independent of the
      // merchant errand (the physical boss DOOR gate is covered by the test below).
      expect(getShopkeeperStage(world)).toBe('not-met');
    });

    it('keeps the final boss door locked until the kill, merchant, and spell quests are all complete', () => {
      const world = createTestWorld({ seed: 123 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const bossDoorEids = world.floor1?.bossDoorEids ?? [];
      expect(bossDoorEids.length).toBeGreaterThan(0);

      const allLocked = (): boolean =>
        bossDoorEids.every((eid) => (world.stores.doorState.isLocked[eid] ?? 0) === 1);
      const allUnlocked = (): boolean =>
        bossDoorEids.every((eid) => (world.stores.doorState.isLocked[eid] ?? 1) === 0);

      // Doors start locked.
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // Only the kill quest done -> still locked.
      world.goalFlags.set('floor1-goon-quest-complete', true);
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // Kill + merchant done -> still locked (spell quest outstanding).
      world.goalFlags.set('floor1-shop-quest-complete', true);
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // All three tutorial quests complete -> door finally unlocks.
      world.goalFlags.set('floor1-boss-battle-complete', true);
      doorSystem(world);
      expect(allUnlocked()).toBe(true);
    });
  });
});
