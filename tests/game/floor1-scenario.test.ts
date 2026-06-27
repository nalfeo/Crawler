import { addComponent, entityExists, query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, Enemy, Position, Rotation, Sprite } from '../../src/core/components.js';
import { spawnBehaviorEnemy, spawnPlayer } from '../../src/core/helpers.js';
import {
  confirmFloor1StairDescend,
  ensureBossBattleSpellReward,
  equipPurchasedGear,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  getNpcQuestIndicatorState,
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
} from '../../src/game/floorScenario.js';
import { getActiveWeapon } from '../../src/game/weaponSystem.js';
import { isQuestComplete, questSystem } from '../../src/core/systems/questSystem.js';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { addItem, hasItem } from '../../src/shared/inventory.js';
import { TileFlags, RoomRole } from '../../src/shared/map-types.js';
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
import { DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID } from '../../src/shared/abilities.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { floor1EnemyPack } from '../../src/shared/enemy-packs.js';

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
      const tile = map.worldToTile(pos.x, pos.y);
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

  it('keeps every room interior reachable from spawn across seeds (no sealed rooms)', () => {
    // Regression: rot-js's Uniform generator occasionally emits a disconnected
    // room that cullIsolatedFloorTiles would wall off. On Floor 1 the affected
    // room is usually the farthest one — tagged BOSS_STAIR — so sealing it strands
    // the staircase (the floor exit) in solid rock and makes the floor unwinnable
    // by any weapon or AI. ensureRoomsReachable carves a deterministic connector
    // before the cull. Seeds 1, 3, 19, 32 reproduced the sealed boss room before
    // the fix; 2/5/6/7/15/25/42 were already well-formed (guards the no-op path).
    for (const seed of [1, 2, 3, 5, 6, 7, 15, 19, 25, 32, 42]) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      const map = world.floorMap!;
      const tm = map.tileMap;
      const w = tm.width;
      const h = tm.height;
      const spawn = map.playerSpawn;

      // Flood from spawn over passable + door tiles (reachability semantics used by
      // cullIsolatedFloorTiles and the AI navigator alike).
      const seen = new Uint8Array(w * h);
      const startIdx = spawn.y * w + spawn.x;
      seen[startIdx] = 1;
      const stack = [startIdx];
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const cx = idx % w;
        const cy = (idx - cx) / w;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as [number, number][]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (seen[nIdx]) continue;
          const flags = tm.flags[nIdx]!;
          if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
          seen[nIdx] = 1;
          stack.push(nIdx);
        }
      }

      const sealed: string[] = [];
      for (const room of map.rooms) {
        const b = room.bounds;
        let hasInterior = false;
        let connected = false;
        for (let ty = b.y + 1; ty < b.y + b.height - 1 && !connected; ty++) {
          for (let tx = b.x + 1; tx < b.x + b.width - 1; tx++) {
            const idx = ty * w + tx;
            if ((tm.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
            hasInterior = true;
            if (seen[idx]) {
              connected = true;
              break;
            }
          }
        }
        if (hasInterior && !connected) {
          sealed.push(`seed ${seed} room ${room.id} (role ${room.role})`);
        }
      }
      expect(sealed).toEqual([]);
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
        const signTile = map.worldToTile(sx, sy);
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

  it('unlocks staircase at killing blow (DeathTimer attached) before entity despawns', () => {
    // Regression: the staircase used to stay locked through the full death animation
    // because the "alive" check used entityExists(), which stays true until
    // DEATH_LINGER_MS expires. The fix adds !hasComponent(DeathTimer) so the unlock
    // fires the instant HP hits 0 (when dropSystem attaches DeathTimer).
    const world = createTestWorld({ seed: 123 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const objective = world.floor1?.objective;
    if (!objective) {
      throw new Error('Expected floor1 objective to exist');
    }

    // Fast-forward through prerequisites.
    objective.ratsKilled = objective.requiredRats;
    objective.slimesKilled = objective.requiredSlimes;
    world.elapsedMs = 1_000;
    floorObjectiveSystem(world);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    floorObjectiveSystem(world);
    questSystem(world);
    floorObjectiveSystem(world);
    floorObjectiveSystem(world);
    meetSpellQuestGiver(world);

    // Trigger Slime Rat battle and defeat it.
    world.stores.position.x[player] = objective.slimeRatRoomPos.x;
    world.stores.position.y[player] = objective.slimeRatRoomPos.y;
    floorObjectiveSystem(world);
    const slimeRatBossEid = objective.bossBattles.get('slime-rat')!.bossEid;
    if (slimeRatBossEid === null) {
      throw new Error('Expected Slime Rat boss to exist');
    }
    removeEntity(world.ecs, slimeRatBossEid);
    floorObjectiveSystem(world);
    meetSpellQuestGiver(world);
    questSystem(world);

    // Move player to staircase zone to trigger the boss encounter.
    world.stores.position.x[player] = objective.staircasePos.x;
    world.stores.position.y[player] = objective.staircasePos.y;
    floorObjectiveSystem(world);
    expect(objective.bossBattles.get('staircase')!.started).toBe(true);

    const bossEid = objective.bossBattles.get('staircase')!.bossEid;
    if (bossEid === null) {
      throw new Error('Expected staircase boss to exist');
    }

    // Simulate the killing blow: attach DeathTimer (what dropSystem does at HP 0)
    // WITHOUT removing the entity — the body is still alive in ECS.
    addComponent(world.ecs, bossEid, DeathTimer);

    // Entity must still exist (death animation linger period).
    expect(entityExists(world.ecs, bossEid)).toBe(true);

    // The staircase should unlock immediately — not after entity despawn.
    floorObjectiveSystem(world);
    expect(objective.staircaseUnlocked).toBe(true);
    expect(objective.staircaseLocked).toBe(false);
    expect(objective.bossBattles.get('staircase')!.defeated).toBe(true);

    // Entity is still present in ECS (body not yet purged).
    expect(entityExists(world.ecs, bossEid)).toBe(true);
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

  describe('boss-battle spell reward hardening (ensureBossBattleSpellReward)', () => {
    const makeReadyWorld = (seed = 99) => {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      return { world, player };
    };

    it('is a no-op until the quest completes (or the flag is set)', () => {
      const { world, player } = makeReadyWorld();
      const granted = ensureBossBattleSpellReward(world, player);
      expect(granted).toBe(false);
      expect(world.featureUnlocks.spells).toBe(false);
      expect(world.abilityStatesByEntity.get(player)).toBeUndefined();
    });

    it('guarantees a concrete spell + the unlock flag on quest completion without any modal', () => {
      const { world, player } = makeReadyWorld();
      // Quest completion signal (questSystem sets this via onCompleteGoalFlag).
      world.goalFlags.set('floor1-boss-battle-complete', true);
      expect(world.featureUnlocks.spells).toBe(false);

      const granted = ensureBossBattleSpellReward(world, player);

      expect(granted).toBe(true);
      expect(world.featureUnlocks.spells).toBe(true);
      const state = world.abilityStatesByEntity.get(player);
      expect(state?.learnedSpellIds).toContain(DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID);
      expect(state?.equippedActiveAbilityIds).toContain(DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID);
    });

    it('repairs a desync where the unlock flag is set but no spell was learned', () => {
      const { world, player } = makeReadyWorld();
      // Degenerate state: flag flipped true with an empty spellbook.
      world.featureUnlocks.spells = true;
      expect(world.abilityStatesByEntity.get(player)).toBeUndefined();

      const granted = ensureBossBattleSpellReward(world, player);

      expect(granted).toBe(true);
      expect(world.featureUnlocks.spells).toBe(true);
      expect(world.abilityStatesByEntity.get(player)?.learnedSpellIds).toContain(
        DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID,
      );
    });

    it('preserves an explicit modal/AI pick and never double-grants (idempotent)', () => {
      const { world, player } = makeReadyWorld();
      world.goalFlags.set('floor1-boss-battle-complete', true);

      // Player explicitly picks fireball via the modal selection path.
      expect(selectSpellFromBossBattle(world, player, 'fireball')).toBe(true);

      // The safety net must not override the choice nor learn a second spell.
      const granted = ensureBossBattleSpellReward(world, player);
      expect(granted).toBe(false);
      expect(world.abilityStatesByEntity.get(player)?.learnedSpellIds).toEqual(['fireball']);
      expect(world.featureUnlocks.spells).toBe(true);

      // Calling again stays a no-op.
      expect(ensureBossBattleSpellReward(world, player)).toBe(false);
      expect(world.abilityStatesByEntity.get(player)?.learnedSpellIds).toEqual(['fireball']);
    });

    it('completing the Slime Rat quest then the safety net yields a learned spell + unlock', () => {
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

      // Win the fight: remove the Slime Rat boss.
      const slimeRatBossEid = objective.bossBattles.get('slime-rat')!.bossEid;
      if (slimeRatBossEid === null) {
        throw new Error('Expected Slime Rat boss to exist');
      }
      removeEntity(world.ecs, slimeRatBossEid);
      floorObjectiveSystem(world);

      // Claim the spellbook -> the boss-battle quest completes.
      meetSpellQuestGiver(world);
      questSystem(world);
      expect(world.goalFlags.get('floor1-boss-battle-complete')).toBe(true);

      // No modal, no AI: the hardening fallback alone guarantees the invariant.
      expect(world.featureUnlocks.spells).toBe(false);
      const granted = ensureBossBattleSpellReward(world, player);
      expect(granted).toBe(true);
      expect(world.featureUnlocks.spells).toBe(true);
      expect(world.abilityStatesByEntity.get(player)?.equippedActiveAbilityIds).toContain(
        DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID,
      );
    });
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

    it('regression: seed 42 seals every special room (all SAFE + boss rooms door-only)', () => {
      const world = createTestWorld({ seed: 42 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const floorMap = world.floorMap!;
      const objective = world.floor1!.objective;

      // Every special room must be enterable only through doors: all SAFE rooms
      // (welcome office, shop, spell broker, and any generator-tagged safe room),
      // every BOSS_STAIR room (the rat-slime boss-stair arena), and the slime-rat
      // quest room. A non-door passable perimeter tile is a tunnel breach.
      const targetRoomIds = new Set<number>();
      for (const room of floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE)) {
        targetRoomIds.add(room.id);
      }
      for (const room of floorMap.roomGraph.getRoomsByRole(RoomRole.BOSS_STAIR)) {
        targetRoomIds.add(room.id);
      }
      const slimeTile = floorMap.worldToTile(
        objective.slimeRatRoomPos.x,
        objective.slimeRatRoomPos.y,
      );
      const slimeRoomId = floorMap.roomGraph.getRoomAt(slimeTile.x, slimeTile.y);
      expect(slimeRoomId).toBeGreaterThanOrEqual(0);
      targetRoomIds.add(slimeRoomId);

      // At least the four SAFE rooms + one boss-stair + slime-rat must be present.
      expect(targetRoomIds.size).toBeGreaterThanOrEqual(5);

      for (const roomId of targetRoomIds) {
        const room = floorMap.roomGraph.get(roomId);
        expect(room).toBeDefined();
        if (!room) continue;

        const knownDoorTiles = new Set(room.doors.map((door) => `${door.x},${door.y}`));
        const perimeter: Array<[number, number]> = [];
        const { x, y, width, height } = room.bounds;
        for (let tx = x; tx < x + width; tx += 1) {
          perimeter.push([tx, y], [tx, y + height - 1]);
        }
        for (let ty = y + 1; ty < y + height - 1; ty += 1) {
          perimeter.push([x, ty], [x + width - 1, ty]);
        }

        for (const [tx, ty] of perimeter) {
          const flags = floorMap.tileMap.flags[ty * floorMap.width + tx]!;
          const isPassable = (flags & TileFlags.PASSABLE) !== 0;
          const isDoor = (flags & TileFlags.DOOR) !== 0;
          const isKnownDoor = knownDoorTiles.has(`${tx},${ty}`);
          if (isPassable && !isDoor && !isKnownDoor) {
            throw new Error(
              `room ${roomId} has non-door perimeter opening at (${tx},${ty}) for seed 42`,
            );
          }
        }
      }
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
      const tile = floorMap.worldToTile(bx, by);
      expect(floorMap.tileMap.isPassable(tile.x, tile.y)).toBe(true);
    });

    it('regression: seed 665790 rat-tail fetch item is accessible without entering the boss room', () => {
      // Seed 665790 placed the rat-tail in a room (room 11) whose only connection
      // was the locked boss staircase room.  The player needed the rat tail to
      // complete the shopkeeper quest — a prerequisite for unlocking the boss room
      // — so the floor was unwinnable and timed out.
      const world = createTestWorld({ seed: 665790 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const floorMap = world.floorMap!;
      const bossRoom = floorMap.bossStairRoom;
      expect(bossRoom).toBeDefined();
      if (!bossRoom) return;

      const questItemPos = world.floor1!.objective.questItemPos;
      const questTile = floorMap.worldToTile(questItemPos.x, questItemPos.y);
      const questRoomId = floorMap.roomGraph.getRoomAt(questTile.x, questTile.y);

      // The quest item room must be reachable from spawn without traversing the
      // boss staircase room. This BFS mirrors the production guard in
      // chooseObjectiveTiles but returns a boolean instead of a Set, so it is
      // kept here as a self-contained test helper rather than a shared utility.
      function canReachWithoutRoom(from: number, to: number, excluding: number): boolean {
        const queue = [from];
        const visited = new Set([from, excluding]);
        while (queue.length > 0) {
          const curr = queue.shift()!;
          if (curr === to) return true;
          for (const n of floorMap.roomGraph.get(curr)?.neighbors ?? []) {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
        return false;
      }

      const spawnRoomId = floorMap.spawnRoom?.id ?? 0;
      expect(canReachWithoutRoom(spawnRoomId, questRoomId, bossRoom.id)).toBe(true);
    });
  });

  describe('npc quest indicators', () => {
    it('shows the tutorial goon as actionable before check-in, then accepted while his quests are active', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      expect(getNpcQuestIndicatorState(world, 'tutorial-goon')).toBe('actionable');

      meetTutorialGoon(world);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'tutorial-goon')).toBe('accepted');
    });

    it('hides locked merchant and spell-broker markers until the welcome quest is complete', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('none');
      expect(getNpcQuestIndicatorState(world, 'spell-quest-giver')).toBe('none');
    });

    it('shows the shopkeeper as actionable when he can offer or advance the quest, and accepted while waiting', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      world.playerLevel.level = 2;
      world.goalFlags.set('floor1-leveling-quest-complete', true);
      world.playerGold = SHOPKEEPER_EQUIPMENT_COST + 10;
      const bag = world.inventories.get(player)!;

      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('actionable');

      meetShopkeeper(world);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('accepted');

      addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('actionable');
      expect(returnShopkeeperPrize(world, player)).toBe(true);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('actionable');

      expect(purchaseShopkeeperEquipment(world, player)).toBe(true);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'shopkeeper')).toBe('accepted');
    });

    it('shows the spell broker as actionable when he can offer or claim the quest, and accepted while the kill is pending', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      world.playerLevel.level = 2;
      world.goalFlags.set('floor1-leveling-quest-complete', true);

      expect(getNpcQuestIndicatorState(world, 'spell-quest-giver')).toBe('actionable');

      meetSpellQuestGiver(world);
      questSystem(world);
      expect(getNpcQuestIndicatorState(world, 'spell-quest-giver')).toBe('accepted');

      const battle = world.floor1?.objective.bossBattles.get('slime-rat');
      if (!battle) {
        throw new Error('Expected slime-rat boss battle state');
      }
      battle.defeated = true;

      expect(getNpcQuestIndicatorState(world, 'spell-quest-giver')).toBe('actionable');
    });
  });

  describe('enemy director — spawn density & engagement budget', () => {
    const pack = floor1EnemyPack;

    const countWithin = (
      world: ReturnType<typeof createTestWorld>,
      cx: number,
      cy: number,
      radiusFt: number,
    ): number => {
      const radiusSq = radiusFt * radiusFt;
      let n = 0;
      for (const eid of query(world.ecs, [Enemy, Position])) {
        const dx = (world.stores.position.x[eid] ?? 0) - cx;
        const dy = (world.stores.position.y[eid] ?? 0) - cy;
        if (dx * dx + dy * dy <= radiusSq) n += 1;
      }
      return n;
    };

    const countInRoom = (
      world: ReturnType<typeof createTestWorld>,
      bounds: { x: number; y: number; width: number; height: number },
    ): number => {
      const map = world.floorMap!;
      let n = 0;
      for (const eid of query(world.ecs, [Enemy, Position])) {
        const tile = map.worldToTile(
          world.stores.position.x[eid] ?? 0,
          world.stores.position.y[eid] ?? 0,
        );
        if (
          tile.x >= bounds.x &&
          tile.x < bounds.x + bounds.width &&
          tile.y >= bounds.y &&
          tile.y < bounds.y + bounds.height
        ) {
          n += 1;
        }
      }
      return n;
    };

    const largestNormalRoom = (world: ReturnType<typeof createTestWorld>) =>
      [...world.floorMap!.roomGraph.getRoomsByRole(RoomRole.NORMAL)].sort(
        (a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
      )[0];

    it('burst-spawns several enemies in a single tick (no more one-at-a-time trickle)', () => {
      const world = createTestWorld({ seed: 99 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const before = query(world.ecs, [Enemy]).length;
      world.elapsedMs = 1_000;
      floor1EnemyDirectorSystem(world);
      const burst = query(world.ecs, [Enemy]).length - before;

      // The old director crept in one enemy per interval; the rework spawns a
      // catch-up burst so a fast-moving player is never left with nothing nearby.
      expect(burst).toBeGreaterThan(1);
      expect(burst).toBeLessThanOrEqual(pack.maxSpawnsPerTick);
    });

    it('tops the engaging swarm up to the target while respecting the global cap', () => {
      const world = createTestWorld({ seed: 99 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      const map = world.floorMap!;

      // Stand in the roomiest combat room so the engagement ring is full of valid
      // spawn tiles, then let the director ramp up.
      const room = largestNormalRoom(world);
      expect(room).toBeDefined();
      const cx = room!.bounds.x + Math.floor(room!.bounds.width / 2);
      const cy = room!.bounds.y + Math.floor(room!.bounds.height / 2);
      const center = map.tileToWorld(cx, cy);
      world.stores.position.x[player] = center.x;
      world.stores.position.y[player] = center.y;

      let t = 1_000;
      for (let i = 0; i < 80; i += 1) {
        t += pack.spawnIntervalMs;
        world.elapsedMs = t;
        floor1EnemyDirectorSystem(world);
        // The global ceiling is never breached, however hard the director pushes.
        expect(query(world.ecs, [Enemy]).length).toBeLessThanOrEqual(pack.enemyCap);
      }

      // A real swarm builds up — the global cap is far above the old hard cap of
      // 14 — and the engagement ring around the player is kept populated for
      // constant combat.
      expect(pack.enemyCap).toBeGreaterThan(14);
      expect(query(world.ecs, [Enemy]).length).toBeGreaterThanOrEqual(pack.engageTarget);
      expect(countWithin(world, center.x, center.y, pack.engageRadiusFt)).toBeGreaterThanOrEqual(
        pack.engageTarget,
      );
    });

    it('recycles the furthest stragglers to spawn closer when at the global cap', () => {
      const world = createTestWorld({ seed: 5 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const px = world.stores.position.x[player] ?? 0;
      const py = world.stores.position.y[player] ?? 0;

      // Fill the field to the global cap, all parked well outside the engagement
      // ring but inside the flat despawn distance (so the director won't simply
      // delete them) — the player is momentarily surrounded by nothing close.
      const farX = px + pack.engageRadiusFt + 37.5;
      const existing = query(world.ecs, [Enemy]).length;
      for (let i = existing; i < pack.enemyCap; i += 1) {
        const eid = spawnBehaviorEnemy(world, farX, py, 20, AI_TYPE.CHASE, 0.5, 100, 0);
        world.floor1!.enemyArchetypes.set(eid, 'rat');
      }
      expect(query(world.ecs, [Enemy]).length).toBe(pack.enemyCap);
      const engagingBefore = countWithin(world, px, py, pack.engageRadiusFt);

      world.elapsedMs = 10_000;
      floor1EnemyDirectorSystem(world);

      // Still capped, but the furthest stragglers were recycled into fresh spawns
      // inside the engagement ring — the player has nearby threats again.
      expect(query(world.ecs, [Enemy]).length).toBeLessThanOrEqual(pack.enemyCap);
      expect(countWithin(world, px, py, pack.engageRadiusFt)).toBeGreaterThan(engagingBefore);
    });

    it('pre-populates a freshly entered combat room with a one-time wave', () => {
      let firedSeed = -1;
      for (const seed of [42, 7, 99, 123, 2024, 1, 2, 3, 5, 11, 13, 17, 31, 64]) {
        const world = createTestWorld({ seed });
        const player = spawnPlayer(world, 0, 0);
        initializeFloor1Scenario(world, player);
        selectFloor1StarterWeapon(world, 0);
        const map = world.floorMap!;

        // Largest NORMAL room maximises the interior available for a wave that
        // must keep its distance from the player standing at the room centre.
        const room = largestNormalRoom(world);
        if (!room) continue;
        const cx = room.bounds.x + Math.floor(room.bounds.width / 2);
        const cy = room.bounds.y + Math.floor(room.bounds.height / 2);
        if (map.roomGraph.getRoomAt(cx, cy) !== room.id) continue;

        // Prime the burst timer in the (SPAWN) start room so the engagement
        // top-up is gated off when we step into the combat room, isolating the
        // pre-population spawn.
        world.elapsedMs = 5_000;
        floor1EnemyDirectorSystem(world);

        const center = map.tileToWorld(cx, cy);
        world.stores.position.x[player] = center.x;
        world.stores.position.y[player] = center.y;

        const before = countInRoom(world, room.bounds);
        if (before !== 0) continue; // stray ambient already inside; pick a cleaner seed
        floor1EnemyDirectorSystem(world);
        const delta = countInRoom(world, room.bounds) - before;
        if (delta === 0) continue; // wave roll missed this seed; try the next

        expect(delta).toBeGreaterThanOrEqual(pack.roomWaveMin);
        expect(delta).toBeLessThanOrEqual(pack.roomWaveMax);

        // The wave reads as "already inside" — it keeps clear of the doorway the
        // player just walked through rather than materialising on top of them.
        for (const eid of query(world.ecs, [Enemy, Position])) {
          const ex = world.stores.position.x[eid] ?? 0;
          const ey = world.stores.position.y[eid] ?? 0;
          const dx = ex - center.x;
          const dy = ey - center.y;
          expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(12 * 12);
        }

        // Re-ticking the same room never re-rolls another wave.
        const afterFirst = countInRoom(world, room.bounds);
        floor1EnemyDirectorSystem(world);
        expect(countInRoom(world, room.bounds)).toBe(afterFirst);

        firedSeed = seed;
        break;
      }
      expect(firedSeed).not.toBe(-1);
    });
  });
});
