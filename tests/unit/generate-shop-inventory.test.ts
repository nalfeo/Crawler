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
  getShopArchetype,
  _resetShopArchetypeCache,
} from '../../src/shared/data/shop-archetypes.js';
import tuning from '../../src/shared/data/tuning.json';

const TIER_MULTIPLIER = tuning.shopPricing.floor2TierMultiplier;

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

describe('getShopArchetype', () => {
  it('returns the archetype for a known id', () => {
    const archetypes = loadShopArchetypes();
    const first = archetypes[0]!;
    expect(getShopArchetype(first.id)).toEqual(first);
  });

  it('returns undefined for an unknown id', () => {
    expect(getShopArchetype('no-such-archetype')).toBeUndefined();
  });
});

/**
 * Floor 1 → Floor 2 economy knock-on.
 *
 * Floor 1 gold carries into Floor 2, so raising Floor 1 prices directly cuts
 * Floor 2's opening buying power. This pins the resulting curve: the gold a
 * well-played Floor 1 run carries down must open Floor 2 as a *choice* — enough
 * for a purchase or two at the median price, never enough to clear a shop out
 * on arrival (the "no Floor 2 opening-power inflation" requirement).
 *
 * The carry band is the measured post-repricing spread of unspent gold at
 * Floor 1 exit over the headless gate panel (see
 * `tests/headless/floor1-economy-gate.test.ts`), which includes the ~125 gold of
 * floor-clear loot boxes that always resolve after the last Floor 1 vendor.
 */
describe('Floor 2 opening affordability against Floor 1 carryover', () => {
  const CARRY_LOW = 200;
  const CARRY_HIGH = 450;

  function medianPrice(prices: readonly number[]): number {
    const sorted = [...prices].sort((a, b) => a - b);
    return sorted[sorted.length >> 1]!;
  }

  it('lets the median carry buy at least one median-priced item in every archetype', () => {
    for (const arch of loadShopArchetypes()) {
      const prices = arch.entries.map((entry) =>
        Math.max(1, Math.round(entry.basePrice * arch.priceMultiplier * TIER_MULTIPLIER)),
      );
      const carry = (CARRY_LOW + CARRY_HIGH) / 2;
      expect(Math.min(...prices), arch.id).toBeLessThanOrEqual(carry);
      expect(medianPrice(prices), arch.id).toBeLessThanOrEqual(carry);
    }
  });

  it('never lets the top of the carry band clear out the settlement on arrival', () => {
    // Individual small shops (the apothecary rolls as few as two items) can be
    // bought out on a good carry — that is a fine reward. What must not happen
    // is arriving on Floor 2 able to buy *everything on offer*, which would
    // make Floor 2's own income and shop rolls decorative.
    for (let seed = 0; seed < 50; seed += 1) {
      const settlementTotal = loadShopArchetypes().reduce(
        (sum, arch) =>
          sum +
          generateShopInventory(new SeededRandom(seed), arch).items.reduce(
            (shopSum, item) => shopSum + item.unitPrice,
            0,
          ),
        0,
      );
      expect(settlementTotal, `seed ${seed}`).toBeGreaterThan(CARRY_HIGH * 2);
    }
  });
});
