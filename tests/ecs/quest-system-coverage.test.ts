import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  acceptQuest,
  addQuestCounter,
  emitQuestEvent,
  getQuestObjectiveViews,
  getTrackedQuest,
  isQuestComplete,
  notifyQuestTalk,
  questSystem,
  setQuestCounter,
  setTrackedQuest,
} from '../../src/core/systems/questSystem.js';
import { addItem } from '../../src/shared/inventory.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
} from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('questSystem coverage supplement', () => {
  it('acceptQuest returns undefined for an unknown quest id', () => {
    const world = createTestWorld();
    expect(acceptQuest(world, 'no-such-quest')).toBeUndefined();
  });

  it('isQuestComplete returns false for a quest not in the log', () => {
    const world = createTestWorld();
    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);
  });

  it('getQuestObjectiveViews returns [] when the quest def is unknown', () => {
    const world = createTestWorld();
    const fakeState = {
      questId: 'ghost',
      status: 'active',
      tracked: true,
      progress: {},
      done: {},
    } as const;
    expect(getQuestObjectiveViews(world, fakeState)).toEqual([]);
  });

  describe('counter events', () => {
    it('setQuestCounter floors and clamps the value', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 3.9);
      setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', -5);
      questSystem(world);
      const views = getQuestObjectiveViews(world, world.questLog.get(FLOOR1_BOSS_UNLOCK_QUEST_ID)!);
      expect(views.find((v) => v.def.id === 'kill-rats')?.current).toBe(3);
      expect(views.find((v) => v.def.id === 'kill-slimes')?.current).toBe(0);
    });

    it('addQuestCounter accumulates and completes a multi-objective counter quest', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 4);
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 2);
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', 4);
      questSystem(world);
      expect(isQuestComplete(world, FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(true);
      expect(world.goalFlags.get('floor1-goon-quest-complete')).toBe(true);
    });

    it('ignores counter events targeting a quest that is not active in the log', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      // Quest never accepted → event is a no-op, no throw.
      setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 5);
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 5);
      questSystem(world);
      expect(world.questLog.has(FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);
    });
  });

  describe('multistep hidden objectives', () => {
    it('hides objectives beyond the first incomplete one', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
      questSystem(world);
      const views = getQuestObjectiveViews(world, world.questLog.get(FLOOR1_SHOP_QUEST_ID)!);
      // First objective (talk) is active; the rest are hidden.
      expect(views[0]).toMatchObject({ active: true, hidden: false, complete: false });
      expect(views.slice(1).every((v) => v.hidden)).toBe(true);
    });

    it('reveals the next step after talking to the merchant', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
      notifyQuestTalk(world, 'shopkeeper');
      questSystem(world);
      const views = getQuestObjectiveViews(
        world,
        world.questLog.get(FLOOR1_SHOP_QUEST_ID)!,
        player,
      );
      expect(views.find((v) => v.def.id === 'meet-merchant')?.complete).toBe(true);
      expect(views.find((v) => v.def.id === 'fetch-prize')?.active).toBe(true);
    });

    it('latches a collect objective once the item is picked up', () => {
      const world = createTestWorld();
      const player = spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
      const bag = world.inventories.get(player)!;
      addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
      questSystem(world);
      const quest = world.questLog.get(FLOOR1_SHOP_QUEST_ID)!;
      expect(quest.done['fetch-prize']).toBe(true);
      // Inventory unlocks the moment the fetch item is held.
      expect(world.featureUnlocks.inventory).toBe(true);
    });
  });

  describe('tracking', () => {
    it('re-tracks the first active quest when the tracked one completes', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      world.goalFlags.set('floor1-reach-level-2', true);
      questSystem(world);
      // Tutorial completed; the boss-unlock quest should now be tracked.
      expect(getTrackedQuest(world)?.questId).toBe(FLOOR1_BOSS_UNLOCK_QUEST_ID);
    });

    it('setTrackedQuest focuses a single active quest', () => {
      const world = createTestWorld();
      spawnPlayer(world, 0, 0);
      acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      setTrackedQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      expect(getTrackedQuest(world)?.questId).toBe(FLOOR1_BOSS_UNLOCK_QUEST_ID);
    });
  });

  it('emitQuestEvent + talk latches a talk objective directly', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    emitQuestEvent(world, { type: 'quest.npc.talked', npcId: 'shopkeeper' });
    questSystem(world);
    expect(world.questLog.get(FLOOR1_SHOP_QUEST_ID)!.done['meet-merchant']).toBe(true);
  });
});
