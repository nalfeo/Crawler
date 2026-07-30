import { describe, expect, it, beforeEach } from 'vitest';
import {
  createInventoryBag,
  createTabPreferences,
  addGeneratedEquipmentReference,
  addItem,
  hasGeneratedEquipmentReference,
  listInventoryEntries,
  removeItem,
  removeGeneratedEquipmentReference,
  hasItem,
  getItemCount,
  filterByEquipmentSlot,
  filterEquippable,
  getVisibleTabs,
  listStaticInventorySlots,
  type InventoryBag,
  type TabPreferences,
} from '../../src/shared/inventory.js';
import { customTag, ItemRarity, type ItemDef } from '../../src/shared/items.js';
import type { GeneratedEquipmentInstanceKey } from '../../src/shared/generated-equipment-types.js';

// Small test catalog for deterministic tests
const testCatalog: ItemDef[] = [
  {
    id: 'test-ore',
    name: 'Test Ore',
    description: 'A test material',
    tags: ['Materials'],
    rarity: ItemRarity.Common,
    maxStack: 10,
  },
  {
    id: 'test-sword',
    name: 'Test Sword',
    description: 'A test weapon',
    tags: ['Weapons'],
    rarity: ItemRarity.Rare,
    maxStack: 1,
  },
  {
    id: 'test-potion',
    name: 'Test Potion',
    description: 'A healing potion',
    tags: ['Consumables'],
    rarity: ItemRarity.Uncommon,
    maxStack: 5,
  },
  {
    id: 'stinky-bone',
    name: 'Stinky Bone',
    description: 'Really smelly',
    tags: ['Materials', customTag('Smelly Stuff')],
    rarity: ItemRarity.Common,
    maxStack: 20,
  },
];

describe('InventoryBag', () => {
  let bag: InventoryBag;

  beforeEach(() => {
    bag = createInventoryBag();
  });

  describe('generated equipment references', () => {
    const first = 'gei:v1:inventory-test:0' as GeneratedEquipmentInstanceKey;
    const second = 'gei:v1:inventory-test:1' as GeneratedEquipmentInstanceKey;

    it('exposes static stacks and exact generated keys as discriminated entries', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      addGeneratedEquipmentReference(bag, first);

      expect(listInventoryEntries(bag)).toEqual([
        { kind: 'stackable-static-item', itemId: 'test-ore', quantity: 3 },
        { kind: 'generated-instance', instanceKey: first },
      ]);
    });

    it('rejects a duplicate exact key without changing the bag', () => {
      addGeneratedEquipmentReference(bag, first);
      const before = structuredClone(bag);

      expect(() => addGeneratedEquipmentReference(bag, first)).toThrow(
        'Generated equipment instance already exists in bag',
      );
      expect(bag).toEqual(before);
    });

    it('listInventoryEntries returns a snapshot — mutating a listed entry does not affect the bag', () => {
      addGeneratedEquipmentReference(bag, first);
      const entries = listInventoryEntries(bag);
      const listed = entries.find((e) => e.kind === 'generated-instance');
      expect(listed).toBeDefined();

      // Force-cast to mutate the returned object
      (listed as { instanceKey: string }).instanceKey = 'gei:v1:mutated:0';

      // The bag's stored entry must be unchanged
      expect(hasGeneratedEquipmentReference(bag, first)).toBe(true);
      expect(
        hasGeneratedEquipmentReference(bag, 'gei:v1:mutated:0' as GeneratedEquipmentInstanceKey),
      ).toBe(false);
    });

    it('removes only the requested key and leaves distinct instances intact', () => {
      addGeneratedEquipmentReference(bag, first);
      addGeneratedEquipmentReference(bag, second);

      expect(removeGeneratedEquipmentReference(bag, first)).toEqual({
        kind: 'generated-instance',
        instanceKey: first,
      });
      expect(hasGeneratedEquipmentReference(bag, first)).toBe(false);
      expect(hasGeneratedEquipmentReference(bag, second)).toBe(true);
    });
  });

  describe('addItem', () => {
    it('adds a new item to an empty bag', () => {
      const added = addItem(bag, 'test-ore', 3, testCatalog);
      expect(added).toBe(3);
      const slots = listStaticInventorySlots(bag);
      expect(slots).toHaveLength(1);
      expect(slots[0]).toEqual({ itemId: 'test-ore', quantity: 3 });
    });

    it('stacks identical items', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      addItem(bag, 'test-ore', 5, testCatalog);
      const slots = listStaticInventorySlots(bag);
      expect(slots).toHaveLength(1);
      expect(slots[0]!.quantity).toBe(8);
    });

    it('respects maxStack and creates overflow slots', () => {
      addItem(bag, 'test-ore', 25, testCatalog); // maxStack=10
      const slots = listStaticInventorySlots(bag);
      expect(slots).toHaveLength(3);
      expect(slots[0]!.quantity).toBe(10);
      expect(slots[1]!.quantity).toBe(10);
      expect(slots[2]!.quantity).toBe(5);
    });

    it('non-stackable items create separate slots', () => {
      addItem(bag, 'test-sword', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      expect(listStaticInventorySlots(bag)).toHaveLength(2);
    });

    it('returns 0 for zero or negative quantity', () => {
      expect(addItem(bag, 'test-ore', 0, testCatalog)).toBe(0);
      expect(addItem(bag, 'test-ore', -5, testCatalog)).toBe(0);
      expect(listStaticInventorySlots(bag)).toHaveLength(0);
    });

    it('throws for unknown item ids', () => {
      expect(() => addItem(bag, 'unknown-item', 1, testCatalog)).toThrow('Unknown itemId');
    });

    it('throws when an item def has maxStack <= 0', () => {
      const badCatalog: ItemDef[] = [
        {
          id: 'bad-item',
          name: 'Bad Item',
          description: 'An item with invalid maxStack',
          tags: [],
          rarity: ItemRarity.Common,
          maxStack: 0,
        },
      ];
      expect(() => addItem(bag, 'bad-item', 1, badCatalog)).toThrow('Invalid maxStack');
    });
  });

  describe('removeItem', () => {
    it('removes items from a slot', () => {
      addItem(bag, 'test-ore', 5, testCatalog);
      const removed = removeItem(bag, 'test-ore', 3);
      expect(removed).toBe(3);
      expect(listStaticInventorySlots(bag)[0]!.quantity).toBe(2);
    });

    it('removes the slot when quantity reaches 0', () => {
      addItem(bag, 'test-ore', 5, testCatalog);
      removeItem(bag, 'test-ore', 5);
      expect(listStaticInventorySlots(bag)).toHaveLength(0);
    });

    it('removes across multiple slots', () => {
      addItem(bag, 'test-ore', 25, testCatalog); // 10+10+5 across 3 slots
      const removed = removeItem(bag, 'test-ore', 15);
      expect(removed).toBe(15);
      // Removes from last slot first: 5→0(removed), 10→0(removed), total=15
      const slots = listStaticInventorySlots(bag);
      expect(slots).toHaveLength(1);
      expect(slots[0]!.quantity).toBe(10);
    });

    it('returns actual amount removed if not enough', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      const removed = removeItem(bag, 'test-ore', 10);
      expect(removed).toBe(3);
      expect(listStaticInventorySlots(bag)).toHaveLength(0);
    });

    it('returns 0 for item not in bag', () => {
      expect(removeItem(bag, 'nonexistent', 1)).toBe(0);
    });
  });

  describe('hasItem / getItemCount', () => {
    it('hasItem returns true when item exists', () => {
      addItem(bag, 'test-ore', 5, testCatalog);
      expect(hasItem(bag, 'test-ore')).toBe(true);
      expect(hasItem(bag, 'test-ore', 5)).toBe(true);
      expect(hasItem(bag, 'test-ore', 6)).toBe(false);
    });

    it('hasItem returns false for missing item', () => {
      expect(hasItem(bag, 'test-ore')).toBe(false);
    });

    it('getItemCount sums across slots', () => {
      addItem(bag, 'test-ore', 25, testCatalog); // 10+10+5
      expect(getItemCount(bag, 'test-ore')).toBe(25);
    });

    it('getItemCount returns 0 for missing item', () => {
      expect(getItemCount(bag, 'nonexistent')).toBe(0);
    });
  });

  describe('filterByEquipmentSlot', () => {
    it('returns equippable items for the selected slot only', () => {
      addItem(bag, 'merchants-stained-charm', 1);
      addItem(bag, 'iron-ore', 3);
      addItem(bag, 'iron-sword', 1);
      const neck = filterByEquipmentSlot(bag, 'neck');
      const mainHand = filterByEquipmentSlot(bag, 'mainHand');
      const offHand = filterByEquipmentSlot(bag, 'offHand');

      expect(neck.map((slot) => slot.itemId)).toEqual(['merchants-stained-charm']);
      expect(mainHand.map((slot) => slot.itemId)).toEqual(['iron-sword']);
      expect(offHand).toHaveLength(0);
    });

    it('includes two-handed weapons in both hand slot filters', () => {
      addItem(bag, 'frost-bow', 1);

      expect(filterByEquipmentSlot(bag, 'mainHand').map((slot) => slot.itemId)).toEqual([
        'frost-bow',
      ]);
      expect(filterByEquipmentSlot(bag, 'offHand').map((slot) => slot.itemId)).toEqual([
        'frost-bow',
      ]);
    });
  });

  describe('filterEquippable', () => {
    it('returns every equippable item regardless of slot, excluding non-gear', () => {
      addItem(bag, 'merchants-stained-charm', 1); // neck
      addItem(bag, 'iron-sword', 1); // mainHand
      addItem(bag, 'iron-ore', 3); // material — not equippable

      const equippable = filterEquippable(bag)
        .map((slot) => slot.itemId)
        .sort();
      expect(equippable).toEqual(['iron-sword', 'merchants-stained-charm']);
    });

    it('returns an empty list when the bag has no equippable items', () => {
      addItem(bag, 'iron-ore', 3);
      expect(filterEquippable(bag)).toHaveLength(0);
    });
  });
});

describe('Tab system', () => {
  let bag: InventoryBag;
  let prefs: TabPreferences;

  beforeEach(() => {
    bag = createInventoryBag();
    prefs = createTabPreferences();
  });

  describe('getVisibleTabs', () => {
    it('returns empty for empty bag', () => {
      expect(getVisibleTabs(bag, prefs, testCatalog)).toEqual([]);
    });

    it('only shows tabs for held items', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toEqual(['Materials']);
    });

    it('includes every active tag from held items', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toContain('Materials');
      expect(tabs).toContain('Weapons');
      expect(tabs).not.toContain('Consumables');
    });

    it('includes custom tags from held items', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toContain('Materials');
      expect(tabs).toContain('Smelly Stuff');
    });

    it('respects hidden custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      prefs.hidden.add(customTag('Smelly Stuff'));
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toContain('Materials');
      expect(tabs).not.toContain('Smelly Stuff');
    });

    it('orders known tags before custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      const materialsIdx = tabs.indexOf('Materials');
      const smellyIdx = tabs.indexOf(customTag('Smelly Stuff'));
      expect(materialsIdx).toBeLessThan(smellyIdx);
    });
  });

  describe('reorderTab', () => {
    it('moves a tab to a new position', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      addItem(bag, 'test-potion', 1, testCatalog);

      // Default order has Materials before Weapons before Consumables
      const consumablesIndex = prefs.order.indexOf('Consumables');
      expect(consumablesIndex).toBeGreaterThanOrEqual(0);
      const [consumables] = prefs.order.splice(consumablesIndex, 1);
      prefs.order.splice(0, 0, consumables!);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs[0]).toBe('Consumables');
    });
  });

  describe('hideTab / showTab', () => {
    it('hides and shows custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      const smelly = customTag('Smelly Stuff');

      prefs.hidden.add(smelly);
      expect(getVisibleTabs(bag, prefs, testCatalog)).not.toContain('Smelly Stuff');

      prefs.hidden.delete(smelly);
      expect(getVisibleTabs(bag, prefs, testCatalog)).toContain('Smelly Stuff');
    });
  });
});
