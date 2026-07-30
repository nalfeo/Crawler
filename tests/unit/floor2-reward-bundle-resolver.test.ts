import { describe, expect, it } from 'vitest';
import {
  listGeneratedEquipmentInstances,
  getGeneratedEquipmentInstance,
} from '../../src/core/generated-equipment-registry.js';
import {
  REWARD_BUNDLE_AFFINITY_PROB,
  REWARD_BUNDLE_RARITIES,
  RewardBundleResolutionError,
  alignmentFromRoll,
  resolveEquipmentRewardBundle,
  resolvePlayerBuildAffinity,
  rollAffinityAlignment,
  rollTierRarity,
} from '../../src/game/floor2-reward-bundle-resolver.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import {
  EQUIPMENT_REWARD_TIERS,
  EQUIPMENT_REWARD_TIER_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1 } from '../../src/core/generated-equipment-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

// Two physical + two magic weapon bases so aligned/non-aligned pools are both
// non-empty for either player affinity — the same shape the Floor 2 achievement
// uses.
const PHYSICAL_BASE_A = 'weapon.iron-cleaver';
const PHYSICAL_BASE_B = 'weapon.ashwood-bow';
const MAGIC_BASE_A = 'weapon.ember-wand';
const MAGIC_BASE_B = 'weapon.frost-crook';
const MIXED_BASES = [PHYSICAL_BASE_A, PHYSICAL_BASE_B, MAGIC_BASE_A, MAGIC_BASE_B] as const;

function makeWorld(runKey = 'reward-bundle-test') {
  return createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: runKey });
}

describe('alignmentFromRoll — exact threshold contract', () => {
  it('treats the affinity probability as an exclusive upper bound (< prob)', () => {
    // At exactly the threshold the roll is NOT aligned; just below it, it is.
    for (const rarity of REWARD_BUNDLE_RARITIES) {
      const prob = REWARD_BUNDLE_AFFINITY_PROB[rarity];
      expect(alignmentFromRoll(prob, rarity)).toBe(false);
      expect(alignmentFromRoll(prob - 1e-6, rarity)).toBe(true);
      expect(alignmentFromRoll(0, rarity)).toBe(true);
      expect(alignmentFromRoll(0.999999, rarity)).toBe(false);
    }
  });

  it('encodes exactly Common 25% / Uncommon 50% / Rare 75%', () => {
    expect(REWARD_BUNDLE_AFFINITY_PROB.common).toBe(0.25);
    expect(REWARD_BUNDLE_AFFINITY_PROB.uncommon).toBe(0.5);
    expect(REWARD_BUNDLE_AFFINITY_PROB.rare).toBe(0.75);
  });

  it('rollAffinityAlignment consumes exactly one draw from the supplied rng', () => {
    const rng = new SeededRandom(123);
    const peek = new SeededRandom(123);
    const expected = alignmentFromRoll(peek.next(), 'rare');
    expect(rollAffinityAlignment(rng, 'rare')).toBe(expected);
  });
});

describe('rollTierRarity — per-tier rarity pool contract', () => {
  it('tier1 is common-only and consumes zero RNG draws', () => {
    const rng = new SeededRandom(999);
    const peek = new SeededRandom(999);
    expect(rollTierRarity(rng, 'tier1')).toBe('common');
    // No draw was consumed by rollTierRarity — `rng` and `peek` must still be
    // in lockstep on their very first `.next()` call.
    expect(rng.next()).toBe(peek.next());
  });

  it('tier2/tier3 never draw rare and respect the tier pool order', () => {
    for (const tier of ['tier2', 'tier3'] as const) {
      const pool = EQUIPMENT_REWARD_TIER_RARITIES[tier];
      expect(pool).not.toContain('rare');
      const low = rollTierRarity(new SeededRandom(1), tier);
      const high = rollTierRarity(new SeededRandom(2), tier);
      expect(pool).toContain(low);
      expect(pool).toContain(high);
    }
  });

  it('achievement tiers (tier1–tier3) never resolve rare; tier4 pool includes both uncommon and rare', () => {
    for (const tier of ['tier1', 'tier2', 'tier3'] as const) {
      expect(EQUIPMENT_REWARD_TIER_RARITIES[tier]).not.toContain('rare');
    }
    expect(EQUIPMENT_REWARD_TIER_RARITIES.tier4).toContain('uncommon');
    expect(EQUIPMENT_REWARD_TIER_RARITIES.tier4).toContain('rare');
  });

  it('tier4 respects 85/15 uncommon/rare split via the per-tier weight', () => {
    // Deterministic threshold test: at exactly 0.85 the roll is NOT the primary
    // (uncommon), just below it IS. This mirrors the `< weight` contract in
    // rollTierRarity, analogous to the alignmentFromRoll threshold tests.
    expect(EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS.tier4).toBe(0.85);
    const pool = EQUIPMENT_REWARD_TIER_RARITIES.tier4;
    // Roll just below threshold → primary rarity (uncommon, index 0).
    const rollBelow = rollTierRarity(
      { next: () => EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS.tier4 - 1e-9 } as unknown as SeededRandom,
      'tier4',
    );
    // Roll at exactly threshold → secondary rarity (rare, index 1).
    const rollAtThreshold = rollTierRarity(
      { next: () => EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS.tier4 } as unknown as SeededRandom,
      'tier4',
    );
    expect(rollBelow).toBe(pool[0]); // uncommon (< 0.85 → primary)
    expect(rollAtThreshold).toBe(pool[1]); // rare (>= 0.85 → secondary)
  });
});

describe('resolvePlayerBuildAffinity', () => {
  it('defaults to physical when no weapon is active', () => {
    const world = makeWorld();
    expect(resolvePlayerBuildAffinity(world)).toBe('physical');
  });

  it('is magic when a magic weapon is active', () => {
    const world = makeWorld();
    setActiveWeapon(world, getWeaponDef('ember-wand')!);
    expect(resolvePlayerBuildAffinity(world)).toBe('magic');
  });

  it('is physical when a melee weapon is active', () => {
    const world = makeWorld();
    setActiveWeapon(world, getWeaponDef('iron-cleaver')!);
    expect(resolvePlayerBuildAffinity(world)).toBe('physical');
  });
});

describe('resolveEquipmentRewardBundle — structure and tier rarity bounds', () => {
  it('resolves exactly one instance, tagged with its tier', () => {
    const world = makeWorld();
    const bundle = resolveEquipmentRewardBundle(world, 'floor2-field-kit', MIXED_BASES, 'tier1');
    expect(bundle.schemaVersion).toBe(GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION);
    expect(bundle.achievementId).toBe('floor2-field-kit');
    expect(bundle.tier).toBe('tier1');
    expect(bundle.instanceKeys).toHaveLength(1);
    const rarity = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!.rarity;
    expect(EQUIPMENT_REWARD_TIER_RARITIES.tier1).toContain(rarity);
  });

  it.each(EQUIPMENT_REWARD_TIERS)('%s never resolves a rarity outside its allowed pool', (tier) => {
    for (let seed = 0; seed < 8; seed += 1) {
      const world = createTestWorld({
        seed,
        floor: 2,
        generatedEquipmentRunKey: `tier-bounds-${tier}-${seed}`,
      });
      const bundle = resolveEquipmentRewardBundle(world, 'ach', MIXED_BASES, tier);
      const rarity = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!.rarity;
      expect(EQUIPMENT_REWARD_TIER_RARITIES[tier]).toContain(rarity);
      // Achievement tiers (tier1–tier3) never produce rare; tier4 (boss chests
      // and brutal-difficulty achievements) may.
      if (tier !== 'tier4') {
        expect(rarity).not.toBe('rare');
      }
    }
  });

  it('tier1 always yields Common with zero non-armor stat bonus and zero resolved effects', () => {
    const world = makeWorld();
    const bundle = resolveEquipmentRewardBundle(world, 'a', MIXED_BASES, 'tier1');
    const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
    expect(instance.rarity).toBe('common');
    expect(instance.resolvedEffects).toHaveLength(0);
    const nonArmor = Object.entries(instance.frozen.statBonuses).filter(
      ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
    );
    expect(nonArmor).toHaveLength(0);
  });

  it('is idempotent — a second resolve returns the identical stored bundle without re-rolling', () => {
    const world = makeWorld();
    const first = resolveEquipmentRewardBundle(world, 'a', MIXED_BASES, 'tier2');
    const countAfterFirst = listGeneratedEquipmentInstances(world).length;
    const second = resolveEquipmentRewardBundle(world, 'a', MIXED_BASES, 'tier2');
    expect(second).toBe(first);
    expect(listGeneratedEquipmentInstances(world).length).toBe(countAfterFirst);
  });
});

describe('resolveEquipmentRewardBundle — determinism and isolation', () => {
  it('replays identical instance keys AND record content for the same run key + achievement + tier', () => {
    const worldA = makeWorld('run-x');
    const worldB = makeWorld('run-x');
    const a = resolveEquipmentRewardBundle(worldA, 'ach', MIXED_BASES, 'tier3');
    const b = resolveEquipmentRewardBundle(worldB, 'ach', MIXED_BASES, 'tier3');
    expect(b.instanceKeys).toEqual(a.instanceKeys);
    expect(b.tier).toBe(a.tier);
    // Keys are deterministically `runKey + ordinal`, so equal keys alone do not
    // prove equal base choices, effects, or frozen stats. Compare full records.
    for (let i = 0; i < a.instanceKeys.length; i += 1) {
      const recA = getGeneratedEquipmentInstance(worldA, a.instanceKeys[i]!);
      const recB = getGeneratedEquipmentInstance(worldB, b.instanceKeys[i]!);
      expect(recB).toEqual(recA);
    }
  });

  it('produces distinct streams for different run keys', () => {
    const a = resolveEquipmentRewardBundle(makeWorld('run-x'), 'ach', MIXED_BASES, 'tier2');
    const b = resolveEquipmentRewardBundle(makeWorld('run-y'), 'ach', MIXED_BASES, 'tier2');
    expect(b.instanceKeys).not.toEqual(a.instanceKeys);
  });

  it('produces distinct streams for different tiers on the same run key + achievement', () => {
    // Same world (same run key) so the instance-ordinal counter actually
    // advances between calls — two fresh worlds would both start at ordinal 0
    // and trivially collide regardless of tier/achievement isolation.
    const world = makeWorld('run-tier-iso');
    const a = resolveEquipmentRewardBundle(world, 'ach', MIXED_BASES, 'tier2');
    const b = resolveEquipmentRewardBundle(world, 'ach2', MIXED_BASES, 'tier3');
    expect(b.instanceKeys).not.toEqual(a.instanceKeys);
  });

  it('does not consume the gameplay rng (zero contamination)', () => {
    const withResolve = makeWorld('contam');
    const withoutResolve = makeWorld('contam');
    resolveEquipmentRewardBundle(withResolve, 'ach', MIXED_BASES, 'tier2');
    // The next gameplay draw must match a world that never resolved a bundle.
    expect(withResolve.rng.next()).toBe(withoutResolve.rng.next());
  });
});

describe('resolveEquipmentRewardBundle — fail-closed / rollback', () => {
  it('throws no-run-key and leaves the world untouched when the registry is unconfigured', () => {
    const world = createTestWorld({ seed: 7, floor: 2, generatedEquipmentRunKey: null });
    expect(() => resolveEquipmentRewardBundle(world, 'ach', MIXED_BASES, 'tier1')).toThrow(
      RewardBundleResolutionError,
    );
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('fails closed with illegal-base when a base carries an inherent non-armor stat bonus (Common contract)', () => {
    const world = makeWorld();
    // `travelers-cloak` is a resolvable accessory with moveSpeed + dodgeChance
    // stat bonuses (both non-armor), so the guard fires as 'illegal-base'
    // rather than 'unknown-base'. The MIXED_BASES supply aligned + non-aligned
    // pools so the partition check never fires first.
    let err: unknown;
    try {
      resolveEquipmentRewardBundle(world, 'ach', [...MIXED_BASES, 'travelers-cloak'], 'tier1');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RewardBundleResolutionError);
    expect((err as RewardBundleResolutionError).code).toBe('illegal-base');
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('fails closed with empty-aligned-pool when no base matches the player affinity', () => {
    const world = makeWorld();
    setActiveWeapon(world, getWeaponDef('ember-wand')!); // magic
    // Only physical bases → no magic-aligned candidate.
    let err: unknown;
    try {
      resolveEquipmentRewardBundle(world, 'ach', [PHYSICAL_BASE_A, PHYSICAL_BASE_B], 'tier1');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RewardBundleResolutionError);
    expect((err as RewardBundleResolutionError).code).toBe('empty-aligned-pool');
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('fails closed with empty-nonaligned-pool when every base matches the player affinity', () => {
    const world = makeWorld();
    setActiveWeapon(world, getWeaponDef('ember-wand')!); // magic
    let err: unknown;
    try {
      resolveEquipmentRewardBundle(world, 'ach', [MAGIC_BASE_A, MAGIC_BASE_B], 'tier1');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RewardBundleResolutionError);
    expect((err as RewardBundleResolutionError).code).toBe('empty-nonaligned-pool');
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });

  it('fails closed with illegal-effect-budget when the ambient policy exceeds the reward contract', () => {
    // A globally-valid generation policy (per-rarity budget in [0,2]) can still
    // violate the reward rarity contract (Common 0 / Uncommon ≤1 / Rare ≤2). The
    // resolver must fail closed rather than mint a contract-breaking bundle.
    const world = createTestWorld({
      seed: 7,
      floor: 2,
      generatedEquipmentRunKey: 'reward-bundle-test',
      generatedEquipmentGenerationPolicy: {
        ...DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
        rarityEffectUnits: { common: 1, uncommon: 2, rare: 2 },
      },
    });
    let err: unknown;
    try {
      resolveEquipmentRewardBundle(world, 'ach', MIXED_BASES, 'tier1');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RewardBundleResolutionError);
    expect((err as RewardBundleResolutionError).code).toBe('illegal-effect-budget');
    expect(world.generatedEquipmentRewardBundles.size).toBe(0);
    expect(listGeneratedEquipmentInstances(world).length).toBe(0);
  });
});
