import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  rollEntry,
  rollLootTable,
  resolveLootTables,
  type LootEntry,
  type LootTable,
} from '../../src/shared/loot-tables.js';
import { SeededRandom } from '../../src/shared/random.js';

/**
 * Property-based invariants for the pure loot roll logic. All randomness flows
 * through SeededRandom so every run is deterministic and reproducible.
 */

/** A structurally valid loot entry (min >= 1, max >= min). */
const entryArb = (): fc.Arbitrary<LootEntry> =>
  fc
    .record({
      type: fc.constantFrom('gold' as const, 'xp' as const, 'item' as const),
      value: fc.integer({ min: 0, max: 50 }),
      chance: fc.double({ min: 0, max: 1, noNaN: true }),
      min: fc.integer({ min: 1, max: 10 }),
      span: fc.integer({ min: 0, max: 10 }),
    })
    .map(({ type, value, chance, min, span }) => ({
      type,
      itemId: type === 'item' ? 'bone-shard' : undefined,
      value,
      chance,
      min,
      max: min + span,
    }));

describe('rollEntry invariants (property-based)', () => {
  it('a returned drop always carries quantity in [min, max] and >= 1', () => {
    fc.assert(
      fc.property(entryArb(), fc.integer(), (entry, seed) => {
        const drop = rollEntry(entry, new SeededRandom(seed));
        if (drop === null) return;
        expect(drop.quantity).toBeGreaterThanOrEqual(1);
        expect(drop.quantity).toBeGreaterThanOrEqual(entry.min);
        expect(drop.quantity).toBeLessThanOrEqual(entry.max);
        expect(drop.type).toBe(entry.type);
        expect(drop.value).toBe(entry.value);
        expect(drop.itemId).toBe(entry.itemId);
      }),
    );
  });

  it('never drops when chance <= 0', () => {
    fc.assert(
      fc.property(
        entryArb(),
        fc.double({ min: -5, max: 0, noNaN: true }),
        fc.integer(),
        (entry, chance, seed) => {
          expect(rollEntry({ ...entry, chance }, new SeededRandom(seed))).toBeNull();
        },
      ),
    );
  });

  it('is deterministic: equal seeds produce equal results', () => {
    fc.assert(
      fc.property(entryArb(), fc.integer(), (entry, seed) => {
        expect(rollEntry(entry, new SeededRandom(seed))).toEqual(
          rollEntry(entry, new SeededRandom(seed)),
        );
      }),
    );
  });

  it('a guaranteed fixed-size entry (chance 1, min === max) always drops exactly min', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer(),
        (qty, value, seed) => {
          const entry: LootEntry = { type: 'gold', value, chance: 1, min: qty, max: qty };
          const drop = rollEntry(entry, new SeededRandom(seed));
          expect(drop).not.toBeNull();
          expect(drop!.quantity).toBe(qty);
        },
      ),
    );
  });
});

describe('rollLootTable invariants (property-based)', () => {
  it('never returns more drops than entries and every drop has quantity >= 1', () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { maxLength: 12 }), fc.integer(), (entries, seed) => {
        const drops = rollLootTable(entries, new SeededRandom(seed));
        expect(drops.length).toBeLessThanOrEqual(entries.length);
        for (const drop of drops) {
          expect(drop.quantity).toBeGreaterThanOrEqual(1);
        }
      }),
    );
  });

  it('is deterministic for a fixed seed', () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { maxLength: 12 }), fc.integer(), (entries, seed) => {
        expect(rollLootTable(entries, new SeededRandom(seed))).toEqual(
          rollLootTable(entries, new SeededRandom(seed)),
        );
      }),
    );
  });
});

describe('resolveLootTables invariants (property-based)', () => {
  it('concatenates all defined layers in order and skips undefined ones', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(entryArb(), { maxLength: 5 }), { maxLength: 4 }),
        fc.array(fc.boolean(), { maxLength: 4 }),
        (entryGroups, presentFlags) => {
          const tables: (LootTable | undefined)[] = entryGroups.map((entries, i) =>
            presentFlags[i] === false ? undefined : { id: `t${i}`, entries },
          );

          const merged = resolveLootTables(...tables);

          const expected = tables
            .filter((t): t is LootTable => t !== undefined)
            .flatMap((t) => t.entries);
          expect(merged).toEqual(expected);
          expect(merged.length).toBe(expected.length);
        },
      ),
    );
  });
});
