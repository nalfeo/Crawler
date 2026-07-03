/**
 * Slice 6 · Unit tests for `generateShopInventory` — deterministic seeded
 * shop rolls, price bounds, only-references-existing-items invariant, plus
 * light property fuzz over a seed sweep.
 */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { generateShopInventory } from '../../src/core/generateShopInventory.js';
import {
  loadShopArchetypes,
  knownShopItemIds,
  _resetShopArchetypeCache,
} from '../../src/shared/data/shop-archetypes.js';

function firstArchetype() {
  _resetShopArchetypeCache();
  return loadShopArchetypes()[0]!;
}

describe('generateShopInventory · determinism', () => {
  it('same rng seed + archetype ⇒ identical inventory', () => {
    const arch = firstArchetype();
    const a = generateShopInventory(new SeededRandom(1234), arch);
    const b = generateShopInventory(new SeededRandom(1234), arch);
    expect(a).toEqual(b);
  });

  it('different seeds diverge (over the sweep at least one differs)', () => {
    const arch = firstArchetype();
    const base = generateShopInventory(new SeededRandom(1), arch);
    const others = [2, 3, 5, 7, 11].map((s) => generateShopInventory(new SeededRandom(s), arch));
    // At least one seed rolls a distinct inventory. Weighted-w/o-replacement
    // is small-space but not so small the sweep collapses to a single result.
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(base))).toBe(true);
  });
});

describe('generateShopInventory · item invariants', () => {
  it('only references items known to the shop catalog', () => {
    const known = knownShopItemIds();
    for (const arch of loadShopArchetypes()) {
      for (let seed = 1; seed < 25; seed += 1) {
        const inv = generateShopInventory(new SeededRandom(seed), arch);
        for (const item of inv.items) {
          expect(known.has(item.itemId), `unknown itemId ${item.itemId}`).toBe(true);
        }
      }
    }
  });

  it('every item is unique within a shop (weighted w/o replacement)', () => {
    for (const arch of loadShopArchetypes()) {
      const inv = generateShopInventory(new SeededRandom(999), arch);
      const ids = inv.items.map((i) => i.itemId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('inventory size falls within archetype [min, max]', () => {
    for (const arch of loadShopArchetypes()) {
      for (let seed = 1; seed < 10; seed += 1) {
        const inv = generateShopInventory(new SeededRandom(seed), arch);
        expect(inv.items.length).toBeGreaterThanOrEqual(arch.minInventorySize);
        expect(inv.items.length).toBeLessThanOrEqual(arch.maxInventorySize);
      }
    }
  });
});

describe('generateShopInventory · price bounds', () => {
  it('unitPrice ≥ 1 always', () => {
    for (const arch of loadShopArchetypes()) {
      const inv = generateShopInventory(new SeededRandom(7), arch, {
        tierMultiplier: 0.0001,
      });
      for (const item of inv.items) {
        expect(item.unitPrice).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('unitPrice tracks basePrice × priceMultiplier × tierMultiplier (rounded)', () => {
    const arch = firstArchetype();
    const tier = 1.0;
    const inv = generateShopInventory(new SeededRandom(1234), arch, {
      tierMultiplier: tier,
    });
    for (const item of inv.items) {
      const entry = arch.entries.find((e) => e.itemId === item.itemId)!;
      const expected = Math.max(1, Math.round(entry.basePrice * arch.priceMultiplier * tier));
      expect(item.unitPrice).toBe(expected);
    }
  });
});

describe('generateShopInventory · property (seed sweep)', () => {
  it('every seed ∈ [0, 200) produces a valid inventory for every archetype', () => {
    for (const arch of loadShopArchetypes()) {
      for (let seed = 0; seed < 200; seed += 1) {
        const inv = generateShopInventory(new SeededRandom(seed), arch);
        expect(inv.items.length).toBeGreaterThan(0);
        expect(inv.items.length).toBeLessThanOrEqual(arch.maxInventorySize);
      }
    }
  });
});
