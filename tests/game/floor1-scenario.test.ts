import { query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Rotation, Sprite } from '../../src/core/components.js';
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
  shouldShowSpellSelector,
  startFloor1BossEncounter,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../../src/game/floor1Scenario.js';
import { getActiveWeapon } from '../../src/game/weaponSystem.js';
import { isQuestComplete, questSystem } from '../../src/core/systems/questSystem.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { addItem, hasItem } from '../../src/shared/inventory.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
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

  it('places the rat-tail fetch item in a different room from the Spell Broker', () => {
    // Run several seeds: the Spell Broker must never share a room with the
    // merchant's gross fetch item (spec: "rat tail is not in the same room as
    // the spell guy").
    const roomIdAt = (world: ReturnType<typeof createTestWorld>, pos: { x: number; y: number }) => {
      const map = world.floorMap!;
      const tile = map.pixelToTile(pos.x, pos.y);
      const room = map.rooms.find(
        (r) =>
          tile.x >= r.bounds.x &&
          tile.x < r.bounds.x + r.bounds.width &&
          tile.y >= r.bounds.y &&
          tile.y < r.bounds.y + r.bounds.height,
      );
      return room?.id ?? -1;
    };

    for (const seed of [42, 7, 99, 123, 2024]) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      const objective = world.floor1!.objective;
      const spellPos = objective.spellQuestGiverPos;
      const itemPos = objective.questItemPos;
      // Positions must differ outright...
      expect(`${spellPos.x},${spellPos.y}`).not.toBe(`${itemPos.x},${itemPos.y}`);
      // ...and resolve to distinct rooms.
      const spellRoom = roomIdAt(world, spellPos);
      const itemRoom = roomIdAt(world, itemPos);
      expect(spellRoom).not.toBe(-1);
      expect(itemRoom).not.toBe(-1);
      expect(spellRoom).not.toBe(itemRoom);
    }
  });

  it('never plants a welcome sign on the player spawn tile', () => {
    const WELCOME_SIGN_TEXTURE = 3;
    for (const seed of [42, 7, 99, 123]) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      const map = world.floorMap!;
      const spawnTile = map.playerSpawn;

      // Signs carry Position + Rotation + Sprite; the player does not have Rotation.
      const signs = query(world.ecs, [Position, Rotation, Sprite]);
      for (const eid of signs) {
        if (world.stores.sprite.textureId[eid] !== WELCOME_SIGN_TEXTURE) continue;
        const sx = world.stores.position.x[eid] ?? 0;
        const sy = world.stores.position.y[eid] ?? 0;
        const signTile = map.pixelToTile(sx, sy);
        expect(`${signTile.x},${signTile.y}`).not.toBe(`${spawnTile.x},${spawnTile.y}`);
      }
    }
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
    expect(objective.bossBattles.get('staircase')!.started).toBe(false);
    expect(objective.bossBattles.get('staircase')!.bossEid).toBeNull();
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
    expect(objective.bossBattles.get('staircase')!.bossEid).toBeNull();
    meetSpellQuestGiver(world);

    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.started).toBe(true);
    if (world.floor1 && (world.floor1.bossRoomDoorEids.get('slime-rat') ?? []).length > 0) {
      for (const doorEid of world.floor1.bossRoomDoorEids.get('slime-rat')!) {
        expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      }
    }
    const slimeRatBossEid = objective.bossBattles.get('slime-rat')!.bossEid;
    if (slimeRatBossEid === null) {
      throw new Error('Expected Slime Rat boss to exist');
    }
    removeEntity(world.ecs, slimeRatBossEid);
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.defeated).toBe(true);
    if (world.floor1 && (world.floor1.bossRoomDoorEids.get('slime-rat') ?? []).length > 0) {
      for (const doorEid of world.floor1.bossRoomDoorEids.get('slime-rat')!) {
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
    expect(objective.bossBattles.get('staircase')!.started).toBe(true);
    expect(objective.staircaseDiscovered).toBe(false);

    const bossEid = objective.bossBattles.get('staircase')!.bossEid;
    if (bossEid === null) {
      throw new Error('Expected staircase boss to exist');
    }

    removeEntity(world.ecs, bossEid);
    floorObjectiveSystem(world);
    expect(objective.staircaseSpawned).toBe(true);
    expect(objective.staircaseLocked).toBe(false);
    expect(objective.staircaseUnlocked).toBe(true);
    expect(objective.bossBattles.get('staircase')!.defeated).toBe(true);

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
    world.playerLevel.level = 2;
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    meetSpellQuestGiver(world);
    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);

    expect(objective.bossBattles.get('slime-rat')!.started).toBe(true);
    expect(objective.bossBattles.get('slime-rat')!.bossEid).not.toBeNull();
    if (world.floor1 && (world.floor1.bossRoomDoorEids.get('slime-rat') ?? []).length > 0) {
      for (const doorEid of world.floor1.bossRoomDoorEids.get('slime-rat')!) {
        expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      }
    }
  });

  it('locks Slime Rat room until spell broker quest is accepted, then unlocks on doorSystem tick', () => {
    const world = createTestWorld({ seed: 321 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const floor1 = world.floor1;
    const slimeRatDoorEids = floor1?.bossRoomDoorEids.get('slime-rat') ?? [];
    if (!floor1 || slimeRatDoorEids.length === 0) {
      // No doors generated for this seed — nothing to assert.
      return;
    }

    // Initially all slime rat room doors must be locked.
    for (const doorEid of slimeRatDoorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      expect(world.stores.doorState.isOpen[doorEid]).toBe(0);
    }

    // Accepting the quest via the Spell Broker sets the goal flag that unlocks the door.
    world.playerLevel.level = 2;
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    meetTutorialGoon(world);
    meetSpellQuestGiver(world);

    expect(world.goalFlags.get('floor1-slime-rat-quest-accepted')).toBe(true);

    // Run doorSystem so it processes the newly satisfied unlock condition.
    doorSystem(world);

    for (const doorEid of slimeRatDoorEids) {
      expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
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

  it('unlocks a concrete spell + the ability system from the Slime Rat win (parallel to merchant→inventory)', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.playerLevel.level = 2;
    world.goalFlags.set('floor1-leveling-quest-complete', true);

    const objective = world.floor1?.objective;
    if (!objective) {
      throw new Error('Expected floor1 objective to exist');
    }

    // Accept the Spell Broker quest and start the Slime Rat battle.
    meetSpellQuestGiver(world);
    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.started).toBe(true);

    // Win the fight: remove the Slime Rat boss.
    const slimeRatBossEid = objective.bossBattles.get('slime-rat')!.bossEid;
    if (slimeRatBossEid === null) {
      throw new Error('Expected Slime Rat boss to exist');
    }
    removeEntity(world.ecs, slimeRatBossEid);
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('slime-rat')!.defeated).toBe(true);

    // The ability system stays locked until the spellbook is claimed at the Broker.
    expect(world.featureUnlocks.spells).toBe(false);
    expect(shouldShowSpellSelector(world)).toBe(false);

    // Return to the Spell Broker to claim the spellbook -> boss-battle quest completes.
    meetSpellQuestGiver(world);
    questSystem(world);
    expect(world.goalFlags.get('floor1-boss-spellbook-claimed')).toBe(true);
    expect(world.goalFlags.get('floor1-boss-battle-complete')).toBe(true);

    // The win now offers a concrete spell whose pick unlocks the ability system.
    expect(shouldShowSpellSelector(world)).toBe(true);
    expect(selectSpellFromBossBattle(world, player, 'heal')).toBe(true);
    expect(world.featureUnlocks.spells).toBe(true);
    expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toContain('heal');
  });

  it('auto-accepts then completes the "Leave the Floor" finale via the three-gate flow', () => {
    const world = createTestWorld({ seed: 123 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    // The finale is not offered until the three prerequisite quests are done.
    expect(world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID)).toBe(false);

    // Satisfy the goon kill-grind, merchant errand, and Spell Broker battle gates.
    world.goalFlags.set('floor1-goon-quest-complete', true);
    world.goalFlags.set('floor1-shop-quest-complete', true);
    world.goalFlags.set('floor1-boss-battle-complete', true);

    // The objective tick auto-accepts "Leave the Floor" once all three gates pass.
    floorObjectiveSystem(world);
    expect(world.questLog.has(FLOOR1_LEAVE_FLOOR_QUEST_ID)).toBe(true);
    expect(isQuestComplete(world, FLOOR1_LEAVE_FLOOR_QUEST_ID)).toBe(false);
    expect(world.goalFlags.get('floor1-leave-floor-complete')).not.toBe(true);

    // Defeating the Floor Boss satisfies only the first goal objective.
    world.goalFlags.set('floor1-defeat-boss', true);
    questSystem(world);
    expect(isQuestComplete(world, FLOOR1_LEAVE_FLOOR_QUEST_ID)).toBe(false);
    expect(world.goalFlags.get('floor1-leave-floor-complete')).not.toBe(true);

    // Taking the stairs satisfies the final objective, completing the finale.
    world.goalFlags.set('floor1.objective.staircaseDiscovered', true);
    questSystem(world);
    expect(isQuestComplete(world, FLOOR1_LEAVE_FLOOR_QUEST_ID)).toBe(true);
    expect(world.questLog.get(FLOOR1_LEAVE_FLOOR_QUEST_ID)?.status).toBe('complete');
    expect(world.goalFlags.get('floor1-leave-floor-complete')).toBe(true);
  });

  describe('shopkeeper errand questline', () => {
    it('starts the player on the find-welcome quest and gates NPC quests', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      expect(world.questLog.has(FLOOR1_FIND_WELCOME_QUEST_ID)).toBe(true);
      expect(world.questLog.has(FLOOR1_SHOP_QUEST_ID)).toBe(false);
      expect(world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);
      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);
      expect(getShopkeeperStage(world)).toBe('not-met');
      expect(world.featureUnlocks.inventory).toBe(false);
      expect(world.featureUnlocks.equipment).toBe(false);

      // Meeting the goon completes find-welcome and hands off the level-2 quest.
      meetTutorialGoon(world);
      questSystem(world);
      expect(isQuestComplete(world, FLOOR1_FIND_WELCOME_QUEST_ID)).toBe(true);
      expect(world.questLog.has(FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);

      // The merchant errand is gated behind completing the goon's level-2 quest.
      world.playerLevel.level = 1;
      meetShopkeeper(world);
      questSystem(world);
      expect(world.questLog.has(FLOOR1_SHOP_QUEST_ID)).toBe(false);
      expect(getShopkeeperStage(world)).toBe('not-met');

      // Once the goon's quest completes (reach level 2), the merchant offers the errand.
      world.playerLevel.level = 2;
      floorObjectiveSystem(world);
      questSystem(world);
      expect(world.goalFlags.get('floor1-leveling-quest-complete')).toBe(true);
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
      world.playerLevel.level = 2;
      world.goalFlags.set('floor1-leveling-quest-complete', true);
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
      world.playerLevel.level = 2;
      world.goalFlags.set('floor1-leveling-quest-complete', true);

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
      world.playerLevel.level = 2;
      world.goalFlags.set('floor1-leveling-quest-complete', true);
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

    it('keeps the final boss door locked until all three quests (goon, merchant, spell) are complete', () => {
      const world = createTestWorld({ seed: 123 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const bossDoorEids = world.floor1?.bossRoomDoorEids.get('staircase') ?? [];
      expect(bossDoorEids.length).toBeGreaterThan(0);

      const allLocked = (): boolean =>
        bossDoorEids.every((eid) => (world.stores.doorState.isLocked[eid] ?? 0) === 1);
      const allUnlocked = (): boolean =>
        bossDoorEids.every((eid) => (world.stores.doorState.isLocked[eid] ?? 1) === 0);

      // Doors start locked.
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // Goon kill-grind alone → still locked.
      world.goalFlags.set('floor1-goon-quest-complete', true);
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // Goon + merchant errand → still locked (spell quest outstanding).
      world.goalFlags.set('floor1-shop-quest-complete', true);
      doorSystem(world);
      expect(allLocked()).toBe(true);

      // Goon + merchant + spell battle → all three gates satisfied, door opens.
      world.goalFlags.set('floor1-boss-battle-complete', true);
      doorSystem(world);
      expect(allUnlocked()).toBe(true);
    });

    it('regression: seed 665790 spawns final boss at a passable tile (not in a wall)', () => {
      // Seed 665790 produces a boss room where variety post-processing leaves only a
      // single passable interior tile outside the center±2 random search window.
      // Previously the fallback path placed the boss in a wall.
      const world = createTestWorld({ seed: 665790 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const floorMap = world.floorMap;
      expect(floorMap?.bossStairRoom).toBeDefined();
      if (!floorMap?.bossStairRoom) return;

      const result = startFloor1BossEncounter(world, player);
      expect(result).toBe(true);

      const bossEid = world.floor1?.objective?.bossBattles.get('staircase')?.bossEid;
      expect(bossEid).not.toBeNull();
      expect(bossEid).toBeDefined();

      const bx = world.stores.position.x[bossEid!] ?? 0;
      const by = world.stores.position.y[bossEid!] ?? 0;
      const tile = floorMap.pixelToTile(bx, by);
      expect(floorMap.tileMap.isPassable(tile.x, tile.y)).toBe(true);
    });
  });
});
