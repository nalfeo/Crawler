import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  REWARD_BUNDLE_AFFINITY_PROB,
  REWARD_BUNDLE_RARITIES,
  alignmentFromRoll,
  resolveEquipmentRewardBundle,
  resolvePlayerBuildAffinity,
} from '../../src/game/floor2-reward-bundle-resolver.js';
import { getGeneratedEquipmentBaseAffinity } from '../../src/game/generated-equipment-generator.js';
import { getGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
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

  it('resolver routes generated base from aligned vs non-aligned pool at ~25%/~50%/~75%', () => {
    // Sample the actual resolver output across many run keys for each rarity index,
    // classify the selected baseId against the player affinity pool, and confirm
    // the empirical aligned fraction tracks the exact probability targets. This
    // exercises the full resolver routing path (not just alignmentFromRoll in isolation).
    const SAMPLES = 300;
    for (const [rarityIndex, rarity] of REWARD_BUNDLE_RARITIES.entries()) {
      let alignedCount = 0;
      for (let seed = 0; seed < SAMPLES; seed += 1) {
        const world = createTestWorld({
          seed: 7,
          floor: 2,
          generatedEquipmentRunKey: `affinity-routing-${rarity}-${seed}`,
        });
        // Use physical player affinity so aligned = physical, nonAligned = magic/neutral.
        setActiveWeapon(world, getWeaponDef('iron-cleaver')!);
        const playerAffinity = resolvePlayerBuildAffinity(world);
        const bundle = resolveEquipmentRewardBundle(world, `ach-${seed}`, MIXED_BASES);
        const instanceKey = bundle.instanceKeys[rarityIndex]!;
        const instance = getGeneratedEquipmentInstance(world, instanceKey)!;
        const baseAffinity = getGeneratedEquipmentBaseAffinity(instance.baseId);
        if (baseAffinity === playerAffinity) alignedCount += 1;
      }
      const observed = alignedCount / SAMPLES;
      expect(
        Math.abs(observed - REWARD_BUNDLE_AFFINITY_PROB[rarity]),
        `rarity=${rarity}: observed=${observed.toFixed(3)} expected=${REWARD_BUNDLE_AFFINITY_PROB[rarity]}`,
      ).toBeLessThan(0.07); // generous tolerance for 300 samples per rarity
    }
  });
});

describe('reward bundle resolution — determinism property', () => {
  it('replays identical instance keys AND record content for the same run key + achievement across arbitrary ids', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }).map((n) => `run-${n}`),
        fc.integer({ min: 0, max: 100_000 }).map((n) => `ach-${n}`),
        (runKey, achievementId) => {
          const worldA = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
          const worldB = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
          const a = resolveEquipmentRewardBundle(worldA, achievementId, MIXED_BASES);
          const b = resolveEquipmentRewardBundle(worldB, achievementId, MIXED_BASES);
          expect([...b.instanceKeys]).toEqual([...a.instanceKeys]);
          // Keys are deterministically runKey+ordinal; also compare full records so
          // different base choices, effects, or frozen stats are detected.
          for (let i = 0; i < a.instanceKeys.length; i += 1) {
            const recA = getGeneratedEquipmentInstance(worldA, a.instanceKeys[i]!);
            const recB = getGeneratedEquipmentInstance(worldB, b.instanceKeys[i]!);
            expect(recB).toEqual(recA);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
