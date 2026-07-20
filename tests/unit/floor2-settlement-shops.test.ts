import { describe, expect, it } from 'vitest';
import { generateShopInventory } from '../../src/core/generateShopInventory.js';
import { planFloor2SettlementShops } from '../../src/game/floor2Settlement.js';
import {
  FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  loadShopArchetypes,
  type ShopArchetypeDef,
} from '../../src/shared/data/shop-archetypes.js';
import { SeededRandom } from '../../src/shared/random.js';

function legacyPlan(seed: number, shopCount: 1 | 2) {
  const rng = new SeededRandom(seed);
  const shuffled = [...loadShopArchetypes()];
  rng.shuffle(shuffled);
  const inventories = new Map(
    shuffled
      .slice(0, shopCount)
      .map((archetype) => [archetype.id, generateShopInventory(rng, archetype).items] as const),
  );
  return { inventories, next: rng.next() };
}

describe('Floor 2 settlement shop planning', () => {
  it.each([1, 2] as const)(
    'guarantees one Quartermaster plus %i seeded non-Quartermaster shops',
    (shopCount) => {
      const planned = planFloor2SettlementShops(
        new SeededRandom(42),
        42,
        shopCount,
        loadShopArchetypes(),
      );

      expect(planned).toHaveLength(shopCount + 1);
      expect(
        planned.filter(({ archetype }) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID),
      ).toHaveLength(1);
      expect(
        planned.filter(({ archetype }) => archetype.id !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID),
      ).toHaveLength(shopCount);
    },
  );

  it.each([1, 3, 6, 8])(
    'preserves legacy prefix inventories and world-RNG state for seed %i',
    (seed) => {
      const shopCount = seed % 2 === 0 ? 2 : 1;
      const legacy = legacyPlan(seed, shopCount);
      const rng = new SeededRandom(seed);
      const planned = planFloor2SettlementShops(rng, seed, shopCount, loadShopArchetypes());
      const byId = new Map(planned.map((shop) => [shop.archetype.id, shop.inventory] as const));

      for (const [archetypeId, inventory] of legacy.inventories) {
        expect(byId.get(archetypeId)).toEqual(inventory);
      }
      expect(rng.next()).toBe(legacy.next);
    },
  );

  it('rejects a configured pool without exactly one Quartermaster', () => {
    const archetypes = loadShopArchetypes();
    const withoutQuartermaster = archetypes.filter(
      (archetype) => archetype.id !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    );
    expect(() =>
      planFloor2SettlementShops(new SeededRandom(1), 1, 1, withoutQuartermaster),
    ).toThrowError(/expected exactly one "the-quartermaster" archetype, found 0/);

    const quartermaster = archetypes.find(
      (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    )!;
    expect(() =>
      planFloor2SettlementShops(new SeededRandom(1), 1, 1, [...archetypes, quartermaster]),
    ).toThrowError(/duplicate shop archetype id "the-quartermaster"/);
  });

  it('rejects a configured pool that cannot supply the requested random-shop count', () => {
    const archetypes = loadShopArchetypes();
    const quartermaster = archetypes.find(
      (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    )!;
    const oneOther = archetypes.find(
      (archetype) => archetype.id !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    )!;
    const undersizedPool: readonly ShopArchetypeDef[] = [quartermaster, oneOther];

    expect(() => planFloor2SettlementShops(new SeededRandom(1), 1, 2, undersizedPool)).toThrowError(
      /requires 2 non-Quartermaster shop archetypes, found 1/,
    );
  });
});
