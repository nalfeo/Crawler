import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  acceptQuest,
  getActiveQuests,
  getQuestObjectiveViews,
  getTrackedQuest,
  isQuestComplete,
  notifyQuestTalk,
  questSystem,
  setQuestCounter,
  setTrackedQuest,
} from '../../src/core/systems/questSystem.js';
import { equip, initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { addItem } from '../../src/shared/inventory.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
} from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('questSystem', () => {
  it('accepts a quest and tracks the first one automatically', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    const tutorial = acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    expect(tutorial?.tracked).toBe(true);

    const shop = acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    expect(shop?.tracked).toBe(false);
    expect(getActiveQuests(world)).toHaveLength(2);
  });

  it('is idempotent — re-accepting returns the existing state', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const first = acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    const second = acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    expect(first).toBe(second);
    expect(getActiveQuests(world)).toHaveLength(1);
  });

  it('completes the counter-based tutorial quest and sets its goal flag', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);

    setQuestCounter(world, FLOOR1_TUTORIAL_QUEST_ID, 'kill-rats', 6);
    setQuestCounter(world, FLOOR1_TUTORIAL_QUEST_ID, 'kill-slimes', 4);
    questSystem(world);

    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);
    expect(world.goalFlags.get('floor1-goon-quest-complete')).toBe(true);
    expect(getActiveQuests(world)).toHaveLength(0);
  });

  it('hides multistep objectives beyond the first incomplete one', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const shop = acceptQuest(world, FLOOR1_SHOP_QUEST_ID)!;

    const views = getQuestObjectiveViews(world, shop);
    expect(views[0]?.active).toBe(true);
    expect(views[0]?.hidden).toBe(false);
    // Everything after the first incomplete objective is hidden.
    expect(views.slice(1).every((v) => v.hidden)).toBe(true);
  });

  it('advances the shopkeeper errand through every step to completion', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    initializeBaseStats(world, player);
    const bag = world.inventories.get(player)!;

    // Step 1: meet the merchant.
    notifyQuestTalk(world, 'shopkeeper');
    questSystem(world);
    expect(isQuestComplete(world, FLOOR1_SHOP_QUEST_ID)).toBe(false);

    // Step 2: fetch the gross prize → inventory unlocks.
    addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
    questSystem(world);
    expect(world.featureUnlocks.inventory).toBe(true);

    // Step 3: return the prize (goal flag).
    bag.slots.length = 0;
    world.goalFlags.set('floor1-shop-prize-returned', true);
    questSystem(world);

    // Step 4: acquire the equippable → equipment unlocks.
    addItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);
    questSystem(world);
    expect(world.featureUnlocks.equipment).toBe(true);

    // Step 5: equip it (removes it from the bag, but the buy-gear step stays latched).
    equip(world, player, MERCHANTS_CHARM_DEF, { force: true });
    bag.slots.length = 0;
    questSystem(world);

    expect(isQuestComplete(world, FLOOR1_SHOP_QUEST_ID)).toBe(true);
    expect(world.goalFlags.get('floor1-shop-quest-complete')).toBe(true);
  });

  it('keeps the haveEquippable step latched once satisfied (equip removes the item)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const shop = acceptQuest(world, FLOOR1_SHOP_QUEST_ID)!;
    const bag = world.inventories.get(player)!;

    addItem(bag, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);
    questSystem(world);
    expect(shop.done['buy-gear']).toBe(true);

    // Item leaves the bag on equip; the latch must hold.
    bag.slots.length = 0;
    questSystem(world);
    expect(shop.done['buy-gear']).toBe(true);
  });

  it('setTrackedQuest focuses a single active quest', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);

    setTrackedQuest(world, FLOOR1_SHOP_QUEST_ID);
    expect(getTrackedQuest(world)?.questId).toBe(FLOOR1_SHOP_QUEST_ID);
  });

  it('always keeps exactly one tracked quest among the actives', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    questSystem(world);
    const tracked = getActiveQuests(world).filter((q) => q.tracked);
    expect(tracked).toHaveLength(1);
  });

  describe('invariants (property-based)', () => {
    it('the tutorial quest never completes before both counters hit target', () => {
      fc.assert(
        fc.property(fc.nat({ max: 5 }), fc.nat({ max: 3 }), (rats, slimes) => {
          const world = createTestWorld();
          spawnPlayer(world, 0, 0);
          acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
          setQuestCounter(world, FLOOR1_TUTORIAL_QUEST_ID, 'kill-rats', rats);
          setQuestCounter(world, FLOOR1_TUTORIAL_QUEST_ID, 'kill-slimes', slimes);
          questSystem(world);
          // rats<6 or slimes<4 ⇒ never complete.
          expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);
        }),
      );
    });

    it('counter progress is clamped to a non-negative integer', () => {
      fc.assert(
        fc.property(fc.double({ min: -100, max: 100, noNaN: true }), (value) => {
          const world = createTestWorld();
          spawnPlayer(world, 0, 0);
          const quest = acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID)!;
          setQuestCounter(world, FLOOR1_TUTORIAL_QUEST_ID, 'kill-rats', value);
          const stored = quest.progress['kill-rats']!;
          expect(stored).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(stored)).toBe(true);
        }),
      );
    });
  });
});
