import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
  emitQuestEvent,
} from '../../src/core/systems/questSystem.js';
import { equip, initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { addItem, createInventoryBag } from '../../src/shared/inventory.js';
import { MERCHANTS_CHARM_DEF, getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_EQUIPMENT_ITEM_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  installQuestPacks,
  installDefaultQuestPacks,
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

  it('completes the level-2 tutorial quest and sets its goal flag', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);

    world.goalFlags.set('floor1-reach-level-2', true);
    questSystem(world);

    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);
    expect(world.goalFlags.get('floor1-leveling-quest-complete')).toBe(true);
    expect(getActiveQuests(world)).toHaveLength(0);
  });

  it('completes the counter-based boss-unlock quest and sets its goal flag', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);

    setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 6);
    setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', 4);
    questSystem(world);

    expect(isQuestComplete(world, FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(true);
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
    world.inventories.set(player, createInventoryBag());
    world.goalFlags.set('floor1-shop-prize-returned', true);
    questSystem(world);

    // Step 4: acquire the equippable → equipment unlocks.
    addItem(world.inventories.get(player)!, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);
    questSystem(world);
    expect(world.featureUnlocks.equipment).toBe(true);

    // Step 5: equip it (removes it from the bag, but the buy-gear step stays latched).
    equip(world, player, MERCHANTS_CHARM_DEF, { force: true });
    world.inventories.set(player, createInventoryBag());
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
    world.inventories.set(player, createInventoryBag());
    questSystem(world);
    expect(shop.done['buy-gear']).toBe(true);
  });

  it('does not unlock Floor 1 equipment from non-merchant equippable loot', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    const player = spawnPlayer(world, 0, 0);
    const bag = world.inventories.get(player)!;
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    const nonMerchantEquippable = getEquippableItemIds().find(
      (itemId) => itemId !== SHOPKEEPER_EQUIPMENT_ITEM_ID,
    );
    expect(nonMerchantEquippable).toBeDefined();
    addItem(bag, nonMerchantEquippable!, 1);

    questSystem(world);
    expect(world.featureUnlocks.equipment).toBe(false);
  });

  it('does not unlock Floor 1 equipment from non-merchant loot before the shopkeeper errand is even accepted', () => {
    // Regression test: the merchant-charm gate must apply for the whole floor,
    // not just once `FLOOR1_SHOP_QUEST_ID` is already in the quest log. Picking
    // up unrelated equippable loot before ever talking to the shopkeeper must
    // not unlock Gear early.
    const world = createTestWorld();
    world.floorId = 'floor1';
    const player = spawnPlayer(world, 0, 0);
    const bag = world.inventories.get(player)!;
    const nonMerchantEquippable = getEquippableItemIds().find(
      (itemId) => itemId !== SHOPKEEPER_EQUIPMENT_ITEM_ID,
    );
    expect(nonMerchantEquippable).toBeDefined();
    addItem(bag, nonMerchantEquippable!, 1);

    questSystem(world);
    expect(world.featureUnlocks.equipment).toBe(false);
  });

  it('still unlocks equipment once the merchant charm is acquired', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    const player = spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_SHOP_QUEST_ID);
    addItem(world.inventories.get(player)!, SHOPKEEPER_EQUIPMENT_ITEM_ID, 1);

    questSystem(world);
    expect(world.featureUnlocks.equipment).toBe(true);
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

  it('consumes and clears queued quest events', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
    expect(world.questEvents).toHaveLength(0);

    emitQuestEvent(world, {
      type: 'quest.counter.set',
      questId: FLOOR1_BOSS_UNLOCK_QUEST_ID,
      objectiveId: 'kill-rats',
      value: 3,
    });
    expect(world.questEvents).toHaveLength(1);

    questSystem(world);
    expect(world.questEvents).toHaveLength(0);
    expect(world.questLog.get(FLOOR1_BOSS_UNLOCK_QUEST_ID)?.progress['kill-rats']).toBe(3);
  });

  describe('invariants (property-based)', () => {
    it('the boss-unlock quest never completes before both counters hit target', () => {
      fc.assert(
        fc.property(fc.nat({ max: 5 }), fc.nat({ max: 3 }), (rats, slimes) => {
          const world = createTestWorld();
          spawnPlayer(world, 0, 0);
          acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
          setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', rats);
          setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', slimes);
          questSystem(world);
          // rats<6 or slimes<4 ⇒ never complete.
          expect(isQuestComplete(world, FLOOR1_BOSS_UNLOCK_QUEST_ID)).toBe(false);
        }),
      );
    });

    it('counter progress is clamped to a non-negative integer', () => {
      fc.assert(
        fc.property(fc.double({ min: -100, max: 100, noNaN: true }), (value) => {
          const world = createTestWorld();
          spawnPlayer(world, 0, 0);
          const quest = acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID)!;
          setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', value);
          questSystem(world);
          const stored = quest.progress['kill-rats']!;
          expect(stored).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(stored)).toBe(true);
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Hidden-quest tracking regression tests
// ---------------------------------------------------------------------------
// Uses a minimal injected quest pack so tests don't depend on Floor 2 scenario
// infrastructure. The registry is restored after each test group.

const HIDDEN_QUEST_ID = 'test-hidden-bg-counter';
const VISIBLE_QUEST_ID = 'test-visible-story';

describe('questSystem — hidden quest tracking', () => {
  beforeEach(() => {
    installDefaultQuestPacks();
  });

  afterEach(() => {
    installDefaultQuestPacks();
  });

  function installTestPacks() {
    installQuestPacks([
      {
        version: 1,
        packId: 'test-hidden',
        quests: [
          {
            id: HIDDEN_QUEST_ID,
            title: 'Background Counter',
            summary: 'Passive background task.',
            hidden: true,
            objectives: [{ id: 'bg-kills', label: 'Kill things', kind: 'counter', target: 5 }],
          },
        ],
      },
      {
        version: 1,
        packId: 'test-visible',
        quests: [
          {
            id: VISIBLE_QUEST_ID,
            title: 'Story Quest',
            summary: 'A real story quest.',
            objectives: [
              { id: 'reach-goal', label: 'Reach the goal', kind: 'goal', goalId: 'test-goal' },
            ],
          },
        ],
      },
    ]);
  }

  it('falls back to a hidden quest when no visible quest exists', () => {
    installTestPacks();
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    acceptQuest(world, HIDDEN_QUEST_ID);
    questSystem(world);

    // No visible quests — falls back to the hidden one.
    expect(getTrackedQuest(world)?.questId).toBe(HIDDEN_QUEST_ID);
  });

  it('reassigns tracking from a hidden quest to a visible quest when one is accepted', () => {
    installTestPacks();
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    // Hidden quest accepted first — becomes the tracked quest by fallback.
    acceptQuest(world, HIDDEN_QUEST_ID);
    questSystem(world);
    expect(getTrackedQuest(world)?.questId).toBe(HIDDEN_QUEST_ID);

    // A visible quest is accepted while the hidden one is still tracked.
    // acceptQuest sees hasTracked=true so the new quest gets tracked:false.
    const visible = acceptQuest(world, VISIBLE_QUEST_ID);
    expect(visible?.tracked).toBe(false);

    // questSystem detects: tracked quest is hidden AND a visible quest exists.
    // It must reassign tracking to the visible quest.
    questSystem(world);
    expect(getTrackedQuest(world)?.questId).toBe(VISIBLE_QUEST_ID);
    // Hidden quest is no longer tracked.
    expect(world.questLog.get(HIDDEN_QUEST_ID)?.tracked).toBe(false);
  });

  it('does NOT reassign when the tracked quest is already visible', () => {
    installTestPacks();
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);

    acceptQuest(world, VISIBLE_QUEST_ID);
    questSystem(world);
    expect(getTrackedQuest(world)?.questId).toBe(VISIBLE_QUEST_ID);

    // Accept the hidden quest second — tracking should not move.
    acceptQuest(world, HIDDEN_QUEST_ID);
    questSystem(world);
    expect(getTrackedQuest(world)?.questId).toBe(VISIBLE_QUEST_ID);
    expect(world.questLog.get(HIDDEN_QUEST_ID)?.tracked).toBe(false);
  });
});
