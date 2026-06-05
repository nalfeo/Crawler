import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import {
  rollLootTable,
  rollEntry,
  resolveLootTables,
  LOOT_TABLES,
  type LootEntry,
} from '../../src/shared/loot-tables.js';

describe('loot-tables', () => {
  describe('rollEntry', () => {
    it('returns null when chance roll fails', () => {
      // Seed 42 first next() = ~0.374 which is > 0.1 chance
      const rng = new SeededRandom(100);
      const entry: LootEntry = { type: 'gold', value: 5, chance: 0.01, min: 1, max: 1 };
      // Run enough times to confirm low chance rarely succeeds
      let nullCount = 0;
      for (let i = 0; i < 50; i++) {
        if (rollEntry(entry, rng) === null) nullCount++;
      }
      expect(nullCount).toBeGreaterThan(40);
    });

    it('always drops when chance is 1.0', () => {
      const rng = new SeededRandom(42);
      const entry: LootEntry = { type: 'xp', value: 1, chance: 1.0, min: 1, max: 1 };
      for (let i = 0; i < 20; i++) {
        const drop = rollEntry(entry, rng);
        expect(drop).not.toBeNull();
        expect(drop!.type).toBe('xp');
        expect(drop!.value).toBe(1);
        expect(drop!.quantity).toBe(1);
      }
    });

    it('rolls quantity within min..max range', () => {
      const rng = new SeededRandom(42);
      const entry: LootEntry = { type: 'gold', value: 1, chance: 1.0, min: 2, max: 5 };
      const quantities = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const drop = rollEntry(entry, rng)!;
        expect(drop.quantity).toBeGreaterThanOrEqual(2);
        expect(drop.quantity).toBeLessThanOrEqual(5);
        quantities.add(drop.quantity);
      }
      // With 100 rolls we should hit multiple values
      expect(quantities.size).toBeGreaterThanOrEqual(2);
    });

    it('preserves itemId for item drops', () => {
      const rng = new SeededRandom(42);
      const entry: LootEntry = {
        type: 'item',
        itemId: 'bone-shard',
        value: 1,
        chance: 1.0,
        min: 1,
        max: 1,
      };
      const drop = rollEntry(entry, rng)!;
      expect(drop.type).toBe('item');
      expect(drop.itemId).toBe('bone-shard');
    });
  });

  describe('rollLootTable', () => {
    it('rolls all entries independently', () => {
      const rng = new SeededRandom(42);
      const entries: LootEntry[] = [
        { type: 'xp', value: 1, chance: 1.0, min: 1, max: 1 },
        { type: 'gold', value: 1, chance: 1.0, min: 1, max: 1 },
      ];
      const drops = rollLootTable(entries, rng);
      expect(drops.length).toBe(2);
      expect(drops[0]!.type).toBe('xp');
      expect(drops[1]!.type).toBe('gold');
    });

    it('returns deterministic results with same seed', () => {
      const entries = LOOT_TABLES.BASIC_MELEE.entries;
      const drops1 = rollLootTable(entries, new SeededRandom(42));
      const drops2 = rollLootTable(entries, new SeededRandom(42));
      expect(drops1).toEqual(drops2);
    });

    it('returns different results with different seeds', () => {
      const entries = LOOT_TABLES.BASIC_MELEE.entries;
      // Run many seeds to find divergence
      let found = false;
      for (let seed = 1; seed < 100; seed++) {
        const a = rollLootTable(entries, new SeededRandom(42));
        const b = rollLootTable(entries, new SeededRandom(seed));
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  describe('resolveLootTables', () => {
    it('merges entries from multiple tables', () => {
      const merged = resolveLootTables(LOOT_TABLES.BASIC_MELEE, LOOT_TABLES.FLOOR_1);
      expect(merged.length).toBe(
        LOOT_TABLES.BASIC_MELEE.entries.length + LOOT_TABLES.FLOOR_1.entries.length,
      );
    });

    it('skips undefined tables', () => {
      const merged = resolveLootTables(undefined, LOOT_TABLES.BASIC_MELEE, undefined);
      expect(merged.length).toBe(LOOT_TABLES.BASIC_MELEE.entries.length);
    });

    it('returns empty array when no tables provided', () => {
      const merged = resolveLootTables(undefined, undefined);
      expect(merged.length).toBe(0);
    });
  });
});
