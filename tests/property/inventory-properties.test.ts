import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createInventoryBag,
  addGeneratedEquipmentReference,
  addItem,
  hasGeneratedEquipmentReference,
  removeItem,
  removeGeneratedEquipmentReference,
  hasItem,
  getItemCount,
  type InventoryBag,
} from '../../src/shared/inventory.js';
import { ItemRarity, type ItemDef } from '../../src/shared/items.js';
import type { GeneratedEquipmentInstanceKey } from '../../src/shared/generated-equipment-types.js';

/**
 * Property-based invariants for the pure inventory bag operations. A small
 * deterministic catalog with a spread of maxStack values (including a
 * non-stackable item) exercises the stacking / overflow paths.
 */
const CATALOG: ItemDef[] = [
  {
    id: 'stack-1',
    name: 'Blade',
    description: 'non-stackable',
    tags: ['Weapons'],
    rarity: ItemRarity.Rare,
    maxStack: 1,
  },
  {
    id: 'stack-5',
    name: 'Potion',
    description: 'small stack',
    tags: ['Consumables'],
    rarity: ItemRarity.Uncommon,
    maxStack: 5,
  },
  {
    id: 'stack-20',
    name: 'Ore',
    description: 'big stack',
    tags: ['Materials'],
    rarity: ItemRarity.Common,
    maxStack: 20,
  },
];

const maxStackOf = (id: string): number => CATALOG.find((d) => d.id === id)!.maxStack;
const itemId = () => fc.constantFrom(...CATALOG.map((d) => d.id));

/** Sum of every slot quantity that matches `id`. */
function slotSum(bag: InventoryBag, id: string): number {
  return bag.slots.filter((s) => s.itemId === id).reduce((acc, s) => acc + s.quantity, 0);
}

describe('inventory invariants (property-based)', () => {
  it('adding a positive quantity to an empty bag yields exactly that count', () => {
    fc.assert(
      fc.property(itemId(), fc.integer({ min: 1, max: 200 }), (id, qty) => {
        const bag = createInventoryBag();
        const added = addItem(bag, id, qty, CATALOG);
        expect(added).toBe(qty);
        expect(getItemCount(bag, id)).toBe(qty);
      }),
    );
  });

  it('stack conservation: count equals the slot sum and no slot violates capacity', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(itemId(), fc.integer({ min: 1, max: 50 })), { maxLength: 30 }),
        (additions) => {
          const bag = createInventoryBag();
          for (const [id, qty] of additions) addItem(bag, id, qty, CATALOG);

          for (const id of CATALOG.map((d) => d.id)) {
            expect(slotSum(bag, id)).toBe(getItemCount(bag, id));
          }
          for (const slot of bag.slots) {
            expect(slot.quantity).toBeGreaterThan(0);
            expect(slot.quantity).toBeLessThanOrEqual(maxStackOf(slot.itemId));
          }
        },
      ),
    );
  });

  it('add then remove the same quantity is an inverse (back to zero, no stray slots)', () => {
    fc.assert(
      fc.property(itemId(), fc.integer({ min: 1, max: 200 }), (id, qty) => {
        const bag = createInventoryBag();
        addItem(bag, id, qty, CATALOG);
        const removed = removeItem(bag, id, qty);
        expect(removed).toBe(qty);
        expect(getItemCount(bag, id)).toBe(0);
        expect(bag.slots.some((s) => s.itemId === id)).toBe(false);
      }),
    );
  });

  it('removeItem returns min(requested, available) and never drives count negative', () => {
    fc.assert(
      fc.property(
        itemId(),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 200 }),
        (id, present, requested) => {
          const bag = createInventoryBag();
          if (present > 0) addItem(bag, id, present, CATALOG);

          const removed = removeItem(bag, id, requested);
          expect(removed).toBe(Math.min(requested, present));
          expect(getItemCount(bag, id)).toBe(present - removed);
          expect(getItemCount(bag, id)).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('an interleaved add/remove sequence conserves the running total (floored at 0)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('add' as const, 'remove' as const),
            fc.integer({ min: 1, max: 30 }),
          ),
          { maxLength: 40 },
        ),
        (ops) => {
          const id = 'stack-5';
          const bag = createInventoryBag();
          let expected = 0;
          for (const [kind, qty] of ops) {
            if (kind === 'add') {
              addItem(bag, id, qty, CATALOG);
              expected += qty;
            } else {
              const removed = removeItem(bag, id, qty);
              expected -= removed;
            }
            expect(getItemCount(bag, id)).toBe(expected);
          }
          expect(expected).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('hasItem agrees with getItemCount for any threshold', () => {
    fc.assert(
      fc.property(
        itemId(),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 120 }),
        (id, present, threshold) => {
          const bag = createInventoryBag();
          if (present > 0) addItem(bag, id, present, CATALOG);
          expect(hasItem(bag, id, threshold)).toBe(getItemCount(bag, id) >= threshold);
        },
      ),
    );
  });

  it('generated-key add/remove conserves every distinct exact identity', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { maxLength: 50 }),
        fc.integer({ min: 0, max: 1000 }),
        (ordinals, removedOrdinal) => {
          const bag = createInventoryBag();
          const keys = ordinals.map(
            (ordinal) => `gei:v1:inventory-property:${ordinal}` as GeneratedEquipmentInstanceKey,
          );
          for (const key of keys) addGeneratedEquipmentReference(bag, key);

          const removedKey =
            `gei:v1:inventory-property:${removedOrdinal}` as GeneratedEquipmentInstanceKey;
          const existed = keys.includes(removedKey);
          expect(removeGeneratedEquipmentReference(bag, removedKey) !== undefined).toBe(existed);

          const expected = keys.filter((key) => key !== removedKey);
          // Verify each expected key is still present and the removed key is gone.
          for (const key of expected) {
            expect(hasGeneratedEquipmentReference(bag, key)).toBe(true);
          }
          expect(hasGeneratedEquipmentReference(bag, removedKey)).toBe(false);
        },
      ),
    );
  });

  it('duplicate generated-key insertion is rejected without changing identity count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (ordinal) => {
        const key = `gei:v1:inventory-duplicate:${ordinal}` as GeneratedEquipmentInstanceKey;
        const bag = createInventoryBag();
        addGeneratedEquipmentReference(bag, key);

        expect(() => addGeneratedEquipmentReference(bag, key)).toThrow();
        // The key is still present exactly once after the duplicate rejection —
        // check count directly so a regression that pushes before checking would
        // be caught even though hasGeneratedEquipmentReference uses .some().
        expect(bag.generatedEquipment?.filter((e) => e.instanceKey === key).length).toBe(1);
      }),
    );
  });
});
