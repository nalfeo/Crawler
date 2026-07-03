import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RELATION_MAX,
  RELATION_MIN,
  adjustFactionRelation,
  asFamilyId,
  bandFor,
  initializeFactionRelations,
  speedMultiplierForHate,
} from '../../src/core/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Property-based invariants for the faction-relations model. These pin the
 * guarantees the rest of Floor 2 will rely on:
 *   - `bandFor` is monotonic non-decreasing in relation
 *   - Any sequence of deltas leaves the stored relation in `[0, 100]`
 *   - `speedMultiplierForHate` is bracketed by `[baseSpeed, playerSpeed]`
 *     when `baseSpeed <= playerSpeed`
 */

const goblins = asFamilyId('goblins');

// Band order used to prove monotonicity numerically.
const BAND_RANK: Record<string, number> = {
  hate: 0,
  hostile: 1,
  neutral: 2,
  friendly: 3,
};

describe('faction-relations properties', () => {
  it('bandFor is monotonic non-decreasing in relation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return BAND_RANK[bandFor(lo)]! <= BAND_RANK[bandFor(hi)]!;
      }),
    );
  });

  it('any sequence of deltas keeps the stored relation in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 50 }),
        (deltas) => {
          const world = createTestWorld();
          initializeFactionRelations(world, [goblins]);
          for (const d of deltas) {
            adjustFactionRelation(world, goblins, d);
          }
          const value = world.factionRelations.get(goblins)!;
          return value >= RELATION_MIN && value <= RELATION_MAX;
        },
      ),
    );
  });

  it('speedMultiplierForHate stays within [baseSpeed, playerSpeed] when baseSpeed<=playerSpeed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        (relation, base, player) => {
          const [lo, hi] = base <= player ? [base, player] : [player, base];
          const s = speedMultiplierForHate(relation, lo, hi);
          return s >= lo - 1e-9 && s <= hi + 1e-9;
        },
      ),
    );
  });

  it('speedMultiplierForHate returns baseSpeed when relation>=25 or base>=player', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 25, max: 100 }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        (relation, base, player) => speedMultiplierForHate(relation, base, player) === base,
      ),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.double({ min: 1, max: 5, noNaN: true }),
        (relation, base) => {
          // baseSpeed == playerSpeed → return base unchanged
          return speedMultiplierForHate(relation, base, base) === base;
        },
      ),
    );
  });
});

// Sanity: fast-check is wired.
it('fast-check is installed and usable', () => {
  expect(typeof fc.assert).toBe('function');
});
