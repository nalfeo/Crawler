import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  _REWARD_BUNDLE_AFFINITY_PROB as REWARD_BUNDLE_AFFINITY_PROB,
  _REWARD_BUNDLE_RARITIES as REWARD_BUNDLE_RARITIES,
  _alignmentFromRoll as alignmentFromRoll,
  resolveEquipmentRewardBundle,
  _resolvePlayerBuildAffinity as resolvePlayerBuildAffinity,
} from '../../src/game/floor2-reward-bundle-resolver.js';
import { getGeneratedEquipmentBaseAffinity } from '../../src/game/generated-equipment-generator.js';
import { getGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { SeededRandom } from '../../src/shared/random.js';
import {
  ACHIEVEMENT_EQUIPMENT_REWARD_TIERS,
  EQUIPMENT_REWARD_TIERS,
  EQUIPMENT_REWARD_TIER_RARITIES,
} from '../../src/shared/generated-equipment-types.js';
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
 * Common 25% / Uncommon 50% / Rare 75% targets. These pure-function checks
 * cover `rare` too, since `tier4` (see {@link EQUIPMENT_REWARD_TIER_RARITIES})
 * is Rare-capable — the resolver-routing check below asserts every tier only
 * ever resolves rarities within its own declared pool.
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

  it('resolver routes generated base from aligned vs non-aligned pool at ~25%/~50% (common/uncommon)', () => {
    // Sample the actual resolver output across many run keys using tier2 (whose
    // pool is [common, uncommon], never rare), bucket the outcomes by the
    // rarity that was actually drawn, and confirm each bucket's empirical
    // aligned fraction tracks the exact per-rarity probability target. This
    // exercises the full resolver routing path (not just alignmentFromRoll in
    // isolation) for every rarity an achievement reward can actually resolve.
    const SAMPLES = 600;
    const buckets: Record<'common' | 'uncommon', { aligned: number; total: number }> = {
      common: { aligned: 0, total: 0 },
      uncommon: { aligned: 0, total: 0 },
    };
    for (let seed = 0; seed < SAMPLES; seed += 1) {
      const world = createTestWorld({
        seed: 7,
        floor: 2,
        generatedEquipmentRunKey: `affinity-routing-tier2-${seed}`,
      });
      // Use physical player affinity so aligned = physical, nonAligned = magic/neutral.
      setActiveWeapon(world, getWeaponDef('iron-cleaver')!);
      const playerAffinity = resolvePlayerBuildAffinity(world);
      const bundle = resolveEquipmentRewardBundle(world, `ach-${seed}`, MIXED_BASES, 'tier2');
      const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
      const rarity = instance.rarity as 'common' | 'uncommon';
      const baseAffinity = getGeneratedEquipmentBaseAffinity(instance.baseId);
      buckets[rarity].total += 1;
      if (baseAffinity === playerAffinity) buckets[rarity].aligned += 1;
    }
    for (const rarity of ['common', 'uncommon'] as const) {
      const { aligned, total } = buckets[rarity];
      // tier2 favors common 75/25, so the uncommon bucket is smaller — require
      // a minimum sample size before trusting the empirical fraction.
      expect(total).toBeGreaterThan(30);
      const observed = aligned / total;
      expect(
        Math.abs(observed - REWARD_BUNDLE_AFFINITY_PROB[rarity]),
        `rarity=${rarity}: observed=${observed.toFixed(3)} expected=${REWARD_BUNDLE_AFFINITY_PROB[rarity]} (n=${total})`,
      ).toBeLessThan(0.1); // generous tolerance for a variable-size sub-sample
    }
  });
});

describe('reward bundle resolution — determinism property', () => {
  it('replays identical instance keys AND record content for the same run key + achievement + tier across arbitrary ids', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }).map((n) => `run-${n}`),
        fc.integer({ min: 0, max: 100_000 }).map((n) => `ach-${n}`),
        fc.constantFrom(...EQUIPMENT_REWARD_TIERS),
        (runKey, achievementId, tier) => {
          const worldA = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
          const worldB = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
          const a = resolveEquipmentRewardBundle(worldA, achievementId, MIXED_BASES, tier);
          const b = resolveEquipmentRewardBundle(worldB, achievementId, MIXED_BASES, tier);
          expect([...b.instanceKeys]).toEqual([...a.instanceKeys]);
          expect(b.tier).toBe(a.tier);
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

  it('never resolves a rarity outside the requested tier pool across arbitrary ids', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }).map((n) => `run-${n}`),
        fc.integer({ min: 0, max: 100_000 }).map((n) => `ach-${n}`),
        fc.constantFrom(...ACHIEVEMENT_EQUIPMENT_REWARD_TIERS),
        (runKey, achievementId, tier) => {
          const world = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
          const bundle = resolveEquipmentRewardBundle(world, achievementId, MIXED_BASES, tier);
          const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
          expect(EQUIPMENT_REWARD_TIER_RARITIES[tier]).toContain(instance.rarity);
        },
      ),
      { numRuns: 60 },
    );
  });
});
