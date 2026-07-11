import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { acceptQuest } from '../../src/core/systems/questSystem.js';
import { getQuestWaypoints } from '../../src/core/systems/questWaypoints.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_LEAVE_FLOOR_QUEST_ID,
  FLOOR1_MEET_NPCS_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
} from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';

const POS = {
  staircase: { x: 200, y: 200 },
  welcome: { x: 10, y: 12 },
  slimeRat: { x: 90, y: 30 },
  spell: { x: 150, y: 60 },
  shop: { x: 40, y: 110 },
  item: { x: 175, y: 175 },
  safe: { x: 5, y: 5 },
};

function withFloor1(world: GameWorld): GameWorld {
  world.floor = 1;
  world.floorScenario = {
    protagonistName: 'Test',
    starterWeaponPool: [],
    starterChoices: [],
    selectedWeaponId: null,
    selectedChoiceIndex: null,
    baseStatBonuses: { maxHp: 0, moveSpeed: 0, pickupRange: 0 },
    enemyArchetypes: new Map(),
    guideNpcEid: null,
    spellQuestGiverNpcEid: null,
    shopkeeperNpcEid: null,
    questItemEid: null,
    bossRoomDoorEids: new Map(),
    objective: {
      requiredRats: 6,
      requiredSlimes: 4,
      requiredGold: 50,
      requiredJunk: 2,
      deadlineMs: 600_000,
      staircaseSpawnCountdownMs: 30_000,
      safeRoomPos: { ...POS.safe },
      staircasePos: { ...POS.staircase },
      welcomeOfficePos: { ...POS.welcome },
      slimeRatRoomPos: { ...POS.slimeRat },
      spellQuestGiverPos: { ...POS.spell },
      shopRoomPos: { ...POS.shop },
      questItemPos: { ...POS.item },
      markerRadiusFt: 4,
      questAccepted: false,
      questCompleted: false,
      ratsKilled: 0,
      slimesKilled: 0,
      goldCollected: 0,
      junkCollected: 0,
      safeRoomDiscovered: false,
      staircaseSpawnStartedMs: null,
      staircaseSpawnRemainingMs: null,
      staircaseSpawned: false,
      staircaseLocked: false,
      staircaseUnlocked: false,
      staircaseDiscovered: false,
      bossBattles: new Map(),
    },
    failReason: null,
    runSummary: null,
  };
  return world;
}

describe('getQuestWaypoints', () => {
  it('points at the Welcome Office for the find-welcome talk objective', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: POS.welcome.x, y: POS.welcome.y, kind: 'npc' });
  });

  it('points at the slime-rat room for the boss-battle counter objective', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: POS.slimeRat.x, y: POS.slimeRat.y, kind: 'combat' });
  });

  it('points at the shop for the shopkeeper-errand talk objective', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: POS.shop.x, y: POS.shop.y, kind: 'npc' });
  });

  it('points at the shop for the meet-npcs shop goal', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_MEET_NPCS_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: POS.shop.x, y: POS.shop.y });
  });

  it('points at the staircase as a stairs waypoint for leave-floor', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_LEAVE_FLOOR_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: POS.staircase.x, y: POS.staircase.y, kind: 'stairs' });
  });

  it('returns no waypoint for grind-anywhere objectives (reach level 2)', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);

    expect(getQuestWaypoints(world)).toEqual([]);
  });

  it('returns nothing without a floor1 or tracked quest', () => {
    const noFloor = createTestWorld();
    spawnPlayer(noFloor, 0, 0);
    expect(getQuestWaypoints(noFloor)).toEqual([]);

    const noQuest = withFloor1(createTestWorld());
    spawnPlayer(noQuest, 0, 0);
    expect(getQuestWaypoints(noQuest)).toEqual([]);
  });

  it('prefers the live NPC entity position over the fallback room position', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    const npc = spawnPlayer(world, 64, 48);
    world.floorScenario!.guideNpcEid = npc;
    acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);

    const wps = getQuestWaypoints(world);
    expect(wps[0]).toMatchObject({ x: 64, y: 48, kind: 'npc' });
  });

  it('returns one waypoint for every active quest that has a directional target', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);

    const wps = getQuestWaypoints(world);

    expect(wps.map((wp) => wp.questId)).toEqual([
      FLOOR1_FIND_WELCOME_QUEST_ID,
      FLOOR1_SHOP_QUEST_ID,
      FLOOR1_BOSS_BATTLE_QUEST_ID,
    ]);
  });

  it('does not return waypoints for completed quests', () => {
    const world = withFloor1(createTestWorld());
    spawnPlayer(world, 0, 0);
    const completed = acceptQuest(world, FLOOR1_FIND_WELCOME_QUEST_ID);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    if (!completed) {
      throw new Error('Expected the test quest to be accepted.');
    }
    completed.status = 'complete';

    expect(getQuestWaypoints(world).map((wp) => wp.questId)).toEqual([FLOOR1_SHOP_QUEST_ID]);
  });
});
