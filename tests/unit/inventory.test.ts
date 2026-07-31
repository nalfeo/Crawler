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
  search,
  filterByTag,
  filterByEquipmentSlot,
  filterEquippable,
  sortSlots,
  getActiveTags,
  getVisibleTabs,
  reorderTab,
  hideTab,
  inventoryEntryIdentity,
  showTab,
  type GeneratedInventoryEntryResolver,
  type InventoryBag,
  type TabPreferences,
} from '../../src/shared/inventory.js';
import {
  _customTag as customTag,
  ItemRarity,
  normalizeGeneratedInventoryTag,
  type ItemDef,
} from '../../src/shared/items.js';
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

    it('uses registry-backed generated metadata across tabs, search, slot filtering, and sorting', () => {
      addGeneratedEquipmentReference(bag, first);
      addGeneratedEquipmentReference(bag, second);
      const resolveGenerated: GeneratedInventoryEntryResolver = (entry) =>
        entry.instanceKey === first
          ? {
              name: 'Twin Blade',
              description: 'A rare first copy',
              tags: [normalizeGeneratedInventoryTag('weapon')],
              rarity: 'Rare',
              slots: ['mainHand'],
            }
          : {
              name: 'Twin Blade',
              description: 'A common second copy',
              tags: [normalizeGeneratedInventoryTag('weapon'), customTag('Generated')],
              rarity: 'Common',
              slots: ['offHand'],
            };

      expect(getVisibleTabs(bag, createTabPreferences(), undefined, resolveGenerated)).toContain(
        'Weapons',
      );
      expect(search(bag, 'second copy', undefined, resolveGenerated)).toEqual([
        { kind: 'generated-instance', instanceKey: second },
      ]);
      expect(filterByTag(bag, customTag('Generated'), undefined, resolveGenerated)).toEqual([
        { kind: 'generated-instance', instanceKey: second },
      ]);
      expect(filterByEquipmentSlot(bag, 'offHand', resolveGenerated)).toEqual([
        { kind: 'generated-instance', instanceKey: second },
      ]);
      expect(sortSlots(bag, 'rarity', undefined, resolveGenerated)).toEqual([
        { kind: 'generated-instance', instanceKey: first },
        { kind: 'generated-instance', instanceKey: second },
      ]);
    });

    it('keeps entry identities stable across static stack quantity changes and exact for duplicates', () => {
      addItem(bag, 'test-ore', 2, testCatalog);
      addGeneratedEquipmentReference(bag, first);
      addGeneratedEquipmentReference(bag, second);
      const [staticEntry, firstGenerated, secondGenerated] = listInventoryEntries(bag);

      expect(inventoryEntryIdentity(staticEntry!)).toBe('static:test-ore');
      expect(inventoryEntryIdentity(firstGenerated!)).toBe(`generated:${first}`);
      expect(inventoryEntryIdentity(secondGenerated!)).toBe(`generated:${second}`);
      expect(inventoryEntryIdentity(firstGenerated!)).not.toBe(
        inventoryEntryIdentity(secondGenerated!),
      );

      addItem(bag, 'test-ore', 1, testCatalog);
      expect(inventoryEntryIdentity(listInventoryEntries(bag)[0]!)).toBe(
        inventoryEntryIdentity(staticEntry!),
      );
    });
  });

  describe('addItem', () => {
    it('adds a new item to an empty bag', () => {
      const added = addItem(bag, 'test-ore', 3, testCatalog);
      expect(added).toBe(3);
      expect(bag.slots).toHaveLength(1);
      expect(bag.slots[0]).toEqual({ itemId: 'test-ore', quantity: 3 });
    });

    it('stacks identical items', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      addItem(bag, 'test-ore', 5, testCatalog);
      expect(bag.slots).toHaveLength(1);
      expect(bag.slots[0]!.quantity).toBe(8);
    });

    it('respects maxStack and creates overflow slots', () => {
      addItem(bag, 'test-ore', 25, testCatalog); // maxStack=10
      expect(bag.slots).toHaveLength(3);
      expect(bag.slots[0]!.quantity).toBe(10);
      expect(bag.slots[1]!.quantity).toBe(10);
      expect(bag.slots[2]!.quantity).toBe(5);
    });

    it('non-stackable items create separate slots', () => {
      addItem(bag, 'test-sword', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      expect(bag.slots).toHaveLength(2);
    });

    it('returns 0 for zero or negative quantity', () => {
      expect(addItem(bag, 'test-ore', 0, testCatalog)).toBe(0);
      expect(addItem(bag, 'test-ore', -5, testCatalog)).toBe(0);
      expect(bag.slots).toHaveLength(0);
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
      expect(bag.slots[0]!.quantity).toBe(2);
    });

    it('removes the slot when quantity reaches 0', () => {
      addItem(bag, 'test-ore', 5, testCatalog);
      removeItem(bag, 'test-ore', 5);
      expect(bag.slots).toHaveLength(0);
    });

    it('removes across multiple slots', () => {
      addItem(bag, 'test-ore', 25, testCatalog); // 10+10+5 across 3 slots
      const removed = removeItem(bag, 'test-ore', 15);
      expect(removed).toBe(15);
      // Removes from last slot first: 5→0(removed), 10→0(removed), total=15
      expect(bag.slots).toHaveLength(1);
      expect(bag.slots[0]!.quantity).toBe(10);
    });

    it('returns actual amount removed if not enough', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      const removed = removeItem(bag, 'test-ore', 10);
      expect(removed).toBe(3);
      expect(bag.slots).toHaveLength(0);
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

  describe('search', () => {
    it('finds items by name', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      const results = search(bag, 'ore', testCatalog);
      expect(results).toHaveLength(1);
      expect(results[0]!.itemId).toBe('test-ore');
    });

    it('finds items by description', () => {
      addItem(bag, 'test-potion', 1, testCatalog);
      const results = search(bag, 'healing', testCatalog);
      expect(results).toHaveLength(1);
      expect(results[0]!.itemId).toBe('test-potion');
    });

    it('is case-insensitive', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      expect(search(bag, 'TEST ORE', testCatalog)).toHaveLength(1);
    });

    it('returns empty for no matches', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      expect(search(bag, 'zzzzz', testCatalog)).toHaveLength(0);
    });
  });

  describe('filterByTag', () => {
    it('filters by known tag', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      const materials = filterByTag(bag, 'Materials', testCatalog);
      expect(materials).toHaveLength(1);
      expect(materials[0]!.itemId).toBe('test-ore');
    });

    it('filters by custom tag', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      addItem(bag, 'test-ore', 1, testCatalog);
      const smelly = filterByTag(bag, customTag('Smelly Stuff'), testCatalog);
      expect(smelly).toHaveLength(1);
      expect(smelly[0]!.itemId).toBe('stinky-bone');
    });

    it('multi-tagged items appear in both tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      expect(filterByTag(bag, 'Materials', testCatalog)).toHaveLength(1);
      expect(filterByTag(bag, customTag('Smelly Stuff'), testCatalog)).toHaveLength(1);
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

  describe('sortSlots', () => {
    it('sorts by rarity descending by default', () => {
      addItem(bag, 'test-ore', 1, testCatalog); // Common
      addItem(bag, 'test-sword', 1, testCatalog); // Rare
      addItem(bag, 'test-potion', 1, testCatalog); // Uncommon

      const sorted = sortSlots(bag, 'rarity', testCatalog);
      expect(sorted[0]!.itemId).toBe('test-sword'); // Rare first
      expect(sorted[1]!.itemId).toBe('test-potion'); // Uncommon
      expect(sorted[2]!.itemId).toBe('test-ore'); // Common
    });

    it('sorts by name alphabetically', () => {
      addItem(bag, 'test-sword', 1, testCatalog);
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-potion', 1, testCatalog);

      const sorted = sortSlots(bag, 'name', testCatalog);
      expect(sorted[0]!.itemId).toBe('test-ore');
      expect(sorted[1]!.itemId).toBe('test-potion');
      expect(sorted[2]!.itemId).toBe('test-sword');
    });

    it('sorts by quantity descending', () => {
      addItem(bag, 'test-ore', 3, testCatalog);
      addItem(bag, 'test-potion', 1, testCatalog);
      addItem(bag, 'stinky-bone', 7, testCatalog);

      const sorted = sortSlots(bag, 'quantity', testCatalog);
      expect(sorted[0]!.itemId).toBe('stinky-bone');
      expect(sorted[1]!.itemId).toBe('test-ore');
      expect(sorted[2]!.itemId).toBe('test-potion');
    });

    it('no-resolver path on a mixed bag returns only static slots, not generated entries', () => {
      // Mixed bag: two static items + one generated entry.
      addItem(bag, 'test-sword', 1, testCatalog); // Rare
      addItem(bag, 'test-ore', 2, testCatalog); // Common
      const genKey = 'gei:v1:sort-mixed-test:0' as GeneratedEquipmentInstanceKey;
      addGeneratedEquipmentReference(bag, genKey);

      // No-resolver overload — must return InventorySlot[] over static lane only.
      const sorted = sortSlots(bag, 'rarity', testCatalog);

      // Generated entry must be absent; only the 2 static items returned.
      expect(sorted).toHaveLength(2);
      expect(sorted[0]!.itemId).toBe('test-sword'); // Rare first
      expect(sorted[1]!.itemId).toBe('test-ore'); // Common second

      // Ensure the generated key is not lurking in the result under any shape.
      const keys = sorted.map((s) => ('instanceKey' in s ? s.instanceKey : null));
      expect(keys).not.toContain(genKey);
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

  describe('getActiveTags', () => {
    it('returns empty for empty bag', () => {
      expect(getActiveTags(bag, testCatalog)).toEqual([]);
    });

    it('returns tags of held items', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      addItem(bag, 'test-sword', 1, testCatalog);
      const tags = getActiveTags(bag, testCatalog);
      expect(tags).toContain('Materials');
      expect(tags).toContain('Weapons');
      expect(tags).not.toContain('Consumables');
    });

    it('includes custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      const tags = getActiveTags(bag, testCatalog);
      expect(tags).toContain('Materials');
      expect(tags).toContain('Smelly Stuff');
    });
  });

  describe('getVisibleTabs', () => {
    it('only shows tabs for held items', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toEqual(['Materials']);
    });

    it('respects hidden custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      prefs.hidden.add(customTag('Smelly Stuff'));
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toContain('Materials');
      expect(tabs).not.toContain('Smelly Stuff');
    });

    it('cannot hide known tags', () => {
      addItem(bag, 'test-ore', 1, testCatalog);
      const result = hideTab(prefs, 'Materials');
      expect(result).toBe(false);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs).toContain('Materials');
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
      reorderTab(prefs, 'Consumables', 0);
      const tabs = getVisibleTabs(bag, prefs, testCatalog);
      expect(tabs[0]).toBe('Consumables');
    });
  });

  describe('hideTab / showTab', () => {
    it('hides and shows custom tags', () => {
      addItem(bag, 'stinky-bone', 1, testCatalog);
      const smelly = customTag('Smelly Stuff');

      hideTab(prefs, smelly);
      expect(getVisibleTabs(bag, prefs, testCatalog)).not.toContain('Smelly Stuff');

      showTab(prefs, smelly);
      expect(getVisibleTabs(bag, prefs, testCatalog)).toContain('Smelly Stuff');
    });
  });
});
