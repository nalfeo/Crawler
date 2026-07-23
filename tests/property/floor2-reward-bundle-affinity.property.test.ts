import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  REWARD_BUNDLE_AFFINITY_PROB,
  REWARD_BUNDLE_RARITIES,
  alignmentFromRoll,
  resolveEquipmentRewardBundle,
} from '../../src/game/floor2-reward-bundle-resolver.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';

const MIXED_BASES = [
  'weapon.iron-cleaver',
  'weapon.ashwood-bow',
  'weapon.ember-wand',
  'weapon.frost-crook',
] as const;

/**
 * Property invariants for the reward-bundle affinity roll. Alignment is a pure
 * `roll < prob` threshold, so exactness is asserted at the boundaries in the
 * unit test; here we prove the monotonic/threshold contract holds for arbitrary
 * rolls and confirm the empirical alignment frequency tracks the exact
 * Common 25% / Uncommon 50% / Rare 75% targets.
 */
describe('reward bundle affinity — threshold properties', () => {
  it('is exactly `roll < prob` for every rarity and roll', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999_999_999, noNaN: true }), (roll) => {
        for (const rarity of REWARD_BUNDLE_RARITIES) {
          expect(alignmentFromRoll(roll, rarity)).toBe(roll < REWARD_BUNDLE_AFFINITY_PROB[rarity]);
        }
      }),
    );
  });

  it('empirically aligns at ~25% / ~50% / ~75% over a uniform stream', () => {
    for (const rarity of REWARD_BUNDLE_RARITIES) {
      const rng = new SeededRandom(1234);
      const samples = 20_000;
      let aligned = 0;
      for (let i = 0; i < samples; i += 1) {
        if (alignmentFromRoll(rng.next(), rarity)) aligned += 1;
      }
      const observed = aligned / samples;
      expect(Math.abs(observed - REWARD_BUNDLE_AFFINITY_PROB[rarity])).toBeLessThan(0.02);
    }
  });
});

describe('reward bundle resolution — determinism property', () => {
  it('replays identical instance keys for the same run key + achievement across arbitrary ids', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }).map((n) => `run-${n}`),
        fc.integer({ min: 0, max: 100_000 }).map((n) => `ach-${n}`),
        (runKey, achievementId) => {
          const a = resolveEquipmentRewardBundle(
            createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey }),
            achievementId,
            MIXED_BASES,
          );
          const b = resolveEquipmentRewardBundle(
            createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey }),
            achievementId,
            MIXED_BASES,
          );
          expect([...b.instanceKeys]).toEqual([...a.instanceKeys]);
        },
      ),
      { numRuns: 40 },
    );
  });
});
