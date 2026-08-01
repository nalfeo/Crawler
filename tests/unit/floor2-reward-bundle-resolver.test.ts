import { describe, expect, it } from 'vitest';
import {
  listGeneratedEquipmentInstances,
  getGeneratedEquipmentInstance,
} from '../../src/core/generated-equipment-registry.js';
import {
  _REWARD_BUNDLE_AFFINITY_PROB as REWARD_BUNDLE_AFFINITY_PROB,
  _REWARD_BUNDLE_RARITIES as REWARD_BUNDLE_RARITIES,
  FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT,
  REWARD_BUNDLE_RESOLVER_VERSION,
  RewardBundleResolutionError,
  _alignmentFromRoll as alignmentFromRoll,
  _categoryFromRoll as categoryFromRoll,
  resolveEquipmentRewardBundle,
  _resolvePlayerBuildAffinity as resolvePlayerBuildAffinity,
  _rollAffinityAlignment as rollAffinityAlignment,
  _rollTierRarity as rollTierRarity,
  _computeFloor2RewardPoolTierEligibility as computeFloor2RewardPoolTierEligibility,
  _validateFloor2RewardPoolTierEligibility as validateFloor2RewardPoolTierEligibility,
  _rarityEligibleBaseIds as rarityEligibleBaseIds,
  _Floor2RewardPoolAuthoringError as Floor2RewardPoolAuthoringError,
  _assertGeneratedRewardInstanceLegal as assertGeneratedRewardInstanceLegal,
} from '../../src/game/floor2-reward-bundle-resolver.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import {
  getGeneratedEquipmentBaseAffinity,
  generatedEquipmentBaseHasNonArmorStatBonus,
  _GeneratedEquipmentGeneratorError as GeneratedEquipmentGeneratorError,
  generateEquipmentInstance,
} from '../../src/game/generated-equipment-generator.js';
import {
  FLOOR2_REWARD_POOL_STABLE_IDS,
  FLOOR2_REWARD_POOL_WEAPON_IDS,
  FLOOR2_REWARD_POOL_NON_WEAPON_IDS,
  FLOOR2_ARMOR_SLOT_IDS,
} from '../../src/shared/data/floor2-reward-pool.js';
import { FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS } from '../../src/shared/data/floor2-equipment-wave-b.js';
import { FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES } from '../../src/shared/data/floor2-basic-leather-bases.js';
import {
  EQUIPMENT_REWARD_TIERS,
  EQUIPMENT_REWARD_TIER_RARITIES,
  EQUIPMENT_REWARD_TIER_RARITY_WEIGHTS,
  GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { SeededRandom, hashStringToSeed } from '../../src/shared/random.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
  createGeneratedEquipmentRegistryTransaction,
} from '../../src/core/generated-equipment-registry.js';
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

  describe('post-generation Common contract', () => {
    it('does not throw for a Common instance drawn from a base with inherent non-armor riders (decoupled model: stats from effects only)', () => {
      // Under the decoupled model, no base non-armor stats are spread into
      // generated instances. A Common item from a base with non-armor authoring
      // riders generates ZERO non-armor stats (Common has zero effect units).
      const baseWithNonArmorRiders = FLOOR2_REWARD_POOL_STABLE_IDS.find(
        generatedEquipmentBaseHasNonArmorStatBonus,
      );
      if (baseWithNonArmorRiders === undefined) {
        throw new Error('expected at least one Floor 2 base with an inherent non-armor bonus');
      }
      const world = makeWorld('post-generation-common-guard');
      const transaction = createGeneratedEquipmentRegistryTransaction(world);
      const effectsRng = new SeededRandom(42);
      const instance = generateEquipmentInstance(
        { generatedEquipmentRegistry: transaction.registry, rng: effectsRng },
        { baseId: baseWithNonArmorRiders, itemLevel: 1, rarity: 'common' },
        { rng: effectsRng, allowedEffectKinds: ['stat'] },
      );
      // The decoupled model: no non-armor base stats flow into the instance.
      expect(() => assertGeneratedRewardInstanceLegal(instance, 'common')).not.toThrow();
      const nonArmor = Object.entries(instance.frozen.statBonuses).filter(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      );
      expect(nonArmor).toHaveLength(0);
    });
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

describe('affinity partitioning — physical/magic/neutral candidates', () => {
  // A neutral (non-weapon/armor) base must count as non-aligned for BOTH a
  // physical and a magic player build (see `partitionBases` in
  // floor2-reward-bundle-resolver.ts: "Opposite affinity OR neutral bases
  // both count as non-aligned."). This proves the aligned/non-aligned split
  // stays legal (both pools non-empty, no empty-pool error) for a physical
  // player, a magic player, and — separately — confirms the neutral base is
  // actually reachable from the non-aligned pool for either build.
  const NEUTRAL_ARMOR_BASE = 'travelers-cloak';
  const THREE_WAY_BASES = [PHYSICAL_BASE_A, MAGIC_BASE_A, NEUTRAL_ARMOR_BASE] as const;

  it('getGeneratedEquipmentBaseAffinity classifies weapon bases as physical/magic and armor as neutral', () => {
    expect(getGeneratedEquipmentBaseAffinity(PHYSICAL_BASE_A)).toBe('physical');
    expect(getGeneratedEquipmentBaseAffinity(MAGIC_BASE_A)).toBe('magic');
    expect(getGeneratedEquipmentBaseAffinity(NEUTRAL_ARMOR_BASE)).toBe('neutral');
  });

  it.each(['physical', 'magic'] as const)(
    'resolves without an empty-pool error for a %s player build against a physical+magic+neutral base set',
    (playerAffinity) => {
      const activeWeaponId = playerAffinity === 'physical' ? 'iron-cleaver' : 'ember-wand';
      const sawNeutralInNonAligned = { value: false };
      const sawOppositeInNonAligned = { value: false };
      for (let seed = 0; seed < 40; seed += 1) {
        const world = createTestWorld({
          seed,
          floor: 2,
          generatedEquipmentRunKey: `neutral-affinity-${playerAffinity}-${seed}`,
        });
        setActiveWeapon(world, getWeaponDef(activeWeaponId)!);
        expect(resolvePlayerBuildAffinity(world)).toBe(playerAffinity);
        // Must not throw empty-aligned-pool or empty-nonaligned-pool: the
        // single same-affinity base keeps `aligned` non-empty, and the
        // opposite-affinity base plus the neutral base keep `nonAligned`
        // non-empty, regardless of which affinity the player has.
        const bundle = resolveEquipmentRewardBundle(world, `ach-${seed}`, THREE_WAY_BASES, 'tier2');
        const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
        if (instance.baseId === NEUTRAL_ARMOR_BASE) sawNeutralInNonAligned.value = true;
        const oppositeBase = playerAffinity === 'physical' ? MAGIC_BASE_A : PHYSICAL_BASE_A;
        if (instance.baseId === oppositeBase) sawOppositeInNonAligned.value = true;
      }
      // Not vacuous: across 40 seeds the non-aligned pool (opposite + neutral)
      // must actually have been drawn at least once, and the neutral base
      // specifically must have surfaced as a legal draw.
      expect(sawNeutralInNonAligned.value || sawOppositeInNonAligned.value).toBe(true);
      expect(sawNeutralInNonAligned.value).toBe(true);
    },
  );

  it('fails closed with empty-nonaligned-pool when the only candidates are the player-aligned base and no opposite/neutral base exists', () => {
    const world = makeWorld();
    setActiveWeapon(world, getWeaponDef('iron-cleaver')!); // physical
    let err: unknown;
    try {
      resolveEquipmentRewardBundle(world, 'ach', [PHYSICAL_BASE_A], 'tier1');
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RewardBundleResolutionError);
    expect((err as RewardBundleResolutionError).code).toBe('empty-nonaligned-pool');
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

  it('allows non-armor base riders and still resolves a Common item with no non-armor bonus', () => {
    // Under the decoupled model, bases with inherent non-armor riders are
    // never excluded from Common candidacy — non-armor power is affix-driven.
    // Common draws zero affix effects (RARITY_EFFECT_BUDGET.common === 0), so
    // the generated instance carries no non-armor stats regardless of what
    // the base's catalog definition contains.
    const bases = [...MIXED_BASES, 'travelers-cloak'] as const;
    for (let seed = 0; seed < 24; seed += 1) {
      const world = createTestWorld({
        seed,
        floor: 2,
        generatedEquipmentRunKey: `common-eligibility-${seed}`,
      });
      const bundle = resolveEquipmentRewardBundle(world, 'ach', bases, 'tier1');
      const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
      expect(instance.rarity).toBe('common');
      const nonArmor = Object.entries(instance.frozen.statBonuses).filter(
        ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
      );
      expect(nonArmor).toHaveLength(0);
    }
  });

  it('a non-armor-bonus base drawn at Uncommon carries affix-driven non-armor stats', () => {
    // Same base, same candidate set, tier2 (common/uncommon pool) can roll
    // Common or Uncommon. Under the decoupled model:
    //   - Common draws have zero non-armor stats (0-effect budget).
    //   - Uncommon draws have ≥1 affix-driven non-armor stat.
    // (Rare is intentionally avoided here — travelers-cloak's effect catalog
    // has no legal 2-unit combination.)
    const bases = [...MIXED_BASES, 'travelers-cloak'] as const;
    let sawTravelersCloakUncommon = false;
    for (let seed = 0; seed < 60; seed += 1) {
      const world = createTestWorld({
        seed,
        floor: 2,
        generatedEquipmentRunKey: `common-eligibility-tier2-${seed}`,
      });
      const bundle = resolveEquipmentRewardBundle(world, 'ach', bases, 'tier2');
      const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
      if (instance.baseId === 'travelers-cloak') {
        const nonArmor = Object.entries(instance.frozen.statBonuses).filter(
          ([stat, value]) => stat !== 'armor' && (value ?? 0) !== 0,
        );
        if (instance.rarity === 'uncommon') {
          sawTravelersCloakUncommon = true;
          // Uncommon budget = 1 effect → at least one non-armor stat.
          expect(nonArmor.length).toBeGreaterThan(0);
        } else {
          // Common budget = 0 effects → no non-armor stats.
          expect(nonArmor.length).toBe(0);
        }
      }
    }
    expect(sawTravelersCloakUncommon).toBe(true);
  });

  it('the real 88-item central reward pool keeps both affinity subpools non-empty for every rarity', () => {
    // Under the decoupled model all bases are eligible for Common draws (no
    // base-stat pre-filtering). The full pool must keep both aligned and
    // non-aligned partitions non-empty for every player build and rarity.
    for (const playerAffinity of ['physical', 'magic'] as const) {
      const aligned = FLOOR2_REWARD_POOL_STABLE_IDS.filter(
        (baseId) => getGeneratedEquipmentBaseAffinity(baseId) === playerAffinity,
      );
      const nonAligned = FLOOR2_REWARD_POOL_STABLE_IDS.filter(
        (baseId) => getGeneratedEquipmentBaseAffinity(baseId) !== playerAffinity,
      );
      expect(aligned.length, `${playerAffinity}-aligned pool must be non-empty`).toBeGreaterThan(0);
      expect(nonAligned.length, `non-${playerAffinity} pool must be non-empty`).toBeGreaterThan(0);
    }
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

describe('Floor 2 reward pool tier eligibility — authoring validation (mechanism 1) and exhaustive selection-time coverage (mechanism 2)', () => {
  const weaponIdSet = new Set(FLOOR2_REWARD_POOL_WEAPON_IDS);

  // Slot lookup for every non-weapon base in the pool, used to prove Common
  // non-weapon coverage spans many distinct armor slots rather than one
  // narrow category (the exact concern the user's refinement raised).
  const nonWeaponSlotsById = new Map<string, readonly string[]>();
  for (const def of FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS) {
    nonWeaponSlotsById.set(def.id, def.slots);
  }
  for (const base of FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES) {
    nonWeaponSlotsById.set(base.id, base.slots);
  }

  it('validates the real 88-base pool without throwing at module load (already proven by this test file importing successfully) and returns the exact composition report', () => {
    const report = validateFloor2RewardPoolTierEligibility();
    expect(report).toEqual(
      computeFloor2RewardPoolTierEligibility(FLOOR2_REWARD_POOL_STABLE_IDS, weaponIdSet),
    );
  });

  it('computes the EXACT per-tier/per-rarity composition over the real 88-base pool (deterministic, not sampled)', () => {
    // Ground truth, computed directly from the real catalogs: 88 total =
    // 56 weapons + 32 non-weapons. Under the decoupled model, Common excludes
    // nothing — all 88 bases are eligible at every rarity. 51 physical-aligned
    // weapon bases, 5 magic-aligned weapon bases, 32 neutral non-weapons.
    const report = computeFloor2RewardPoolTierEligibility(
      FLOOR2_REWARD_POOL_STABLE_IDS,
      weaponIdSet,
    );

    const fullComposition = {
      total: 88,
      weapons: 56,
      nonWeapons: 32,
      physicalAligned: 51,
      magicAligned: 5,
      neutral: 32,
    };

    expect(report.tier1.common).toEqual(fullComposition);
    expect(report.tier2.common).toEqual(fullComposition);
    expect(report.tier2.uncommon).toEqual(fullComposition);
    expect(report.tier3.uncommon).toEqual(fullComposition);
    expect(report.tier3.common).toEqual(fullComposition);

    // Sanity cross-checks against the pool's own published totals.
    expect(FLOOR2_REWARD_POOL_STABLE_IDS.length).toBe(88);
    expect(FLOOR2_REWARD_POOL_WEAPON_IDS.length).toBe(56);
    expect(FLOOR2_REWARD_POOL_NON_WEAPON_IDS.length).toBe(32);
  });

  it('tier1 (Common-only) covers all non-weapon armor slots — no slot gaps under the decoupled model', () => {
    // Under the decoupled model, all 32 non-weapon bases are Common-eligible
    // (no base-stat pre-filtering). This means all 16 armor slots are
    // reachable from tier1 Common draws, eliminating the historical slot
    // gaps (neck/belt/ringLeft/ringRight) that existed under the old model
    // where 22 accessory-style non-weapons were excluded.
    const allNonWeapons = FLOOR2_REWARD_POOL_STABLE_IDS.filter((id) => !weaponIdSet.has(id));
    expect(allNonWeapons).toHaveLength(32);

    const coveredSlots = new Set<string>();
    for (const id of allNonWeapons) {
      for (const slot of nonWeaponSlotsById.get(id) ?? []) coveredSlots.add(slot);
    }
    const uncoveredArmorSlots = FLOOR2_ARMOR_SLOT_IDS.filter((slot) => !coveredSlots.has(slot));
    expect(uncoveredArmorSlots).toHaveLength(0);
  });

  it('every base in the pool is legal for at least one achievement rarity/tier — uncommon never excludes, so the union is exhaustive', () => {
    const uncommonEligible = rarityEligibleBaseIds(FLOOR2_REWARD_POOL_STABLE_IDS, 'uncommon');
    expect(uncommonEligible).toHaveLength(FLOOR2_REWARD_POOL_STABLE_IDS.length);
    expect(new Set(uncommonEligible)).toEqual(new Set(FLOOR2_REWARD_POOL_STABLE_IDS));
  });

  it('EXHAUSTIVELY (not sampled) proves every achievement-reachable tier × rarity × player-build partition is non-empty on both sides', () => {
    for (const tier of ['tier1', 'tier2', 'tier3'] as const) {
      for (const rarity of tier === 'tier1'
        ? (['common'] as const)
        : (['common', 'uncommon'] as const)) {
        const eligible = rarityEligibleBaseIds(FLOOR2_REWARD_POOL_STABLE_IDS, rarity);
        for (const playerAffinity of ['physical', 'magic'] as const) {
          const aligned = eligible.filter(
            (id) => getGeneratedEquipmentBaseAffinity(id) === playerAffinity,
          );
          const nonAligned = eligible.filter(
            (id) => getGeneratedEquipmentBaseAffinity(id) !== playerAffinity,
          );
          expect(
            aligned.length,
            `tier ${tier} rarity ${rarity} ${playerAffinity}-aligned pool must be non-empty`,
          ).toBeGreaterThan(0);
          expect(
            nonAligned.length,
            `tier ${tier} rarity ${rarity} non-${playerAffinity} pool must be non-empty`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('fails loudly (does not silently narrow or return an empty result) for an unresolvable/unknown base', () => {
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(['not-a-real-base-id'], new Set());
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(GeneratedEquipmentGeneratorError);
    expect((err as GeneratedEquipmentGeneratorError).code).toBe('unknown-base');
  });

  it('throws Floor2RewardPoolAuthoringError (not a silent/permissive filter) when a tier/rarity/build combination has no aligned candidate', () => {
    // Only physical weapon bases in the supplied pool → tier1's Common draw
    // has zero magic-aligned candidates. The check must throw explicitly,
    // never silently narrow to an empty-but-still-"valid" result.
    const physicalOnly = FLOOR2_REWARD_POOL_STABLE_IDS.filter(
      (id) => getGeneratedEquipmentBaseAffinity(id) === 'physical',
    );
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(physicalOnly, weaponIdSet);
    } catch (caught) {
      err = caught;
    }
    // BUILD_AFFINITIES is checked physical-first: a physical-only pool has a
    // non-empty physical-aligned side but an empty non-physical (magic) side.
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(/no non-physical candidate/);
  });

  it('throws Floor2RewardPoolAuthoringError when every candidate matches the player build (empty aligned pool for the opposite build)', () => {
    const magicOnly = FLOOR2_REWARD_POOL_STABLE_IDS.filter(
      (id) => getGeneratedEquipmentBaseAffinity(id) === 'magic',
    );
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(magicOnly, weaponIdSet);
    } catch (caught) {
      err = caught;
    }
    // Checked physical-first: a magic-only pool has zero physical-aligned
    // candidates, so the "aligned" branch fires before "non-aligned" ever
    // would for the magic build.
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(/no physical-aligned candidate/);
  });

  it('throws Floor2RewardPoolAuthoringError when weaponIds is non-empty but no pool bases match any weapon ID', () => {
    // Need a pool that passes the outer full-pool check (both aligned and
    // nonAligned are non-empty for every build) but fails the new guard that
    // fires when weaponIds ∩ bases = ∅. Use a mixed-affinity pool so the outer
    // check passes, then supply a weaponIds set whose IDs are absent from bases.
    const onePhysical = FLOOR2_REWARD_POOL_STABLE_IDS.find(
      (id) => getGeneratedEquipmentBaseAffinity(id) === 'physical',
    )!;
    const oneMagic = FLOOR2_REWARD_POOL_STABLE_IDS.find(
      (id) => getGeneratedEquipmentBaseAffinity(id) === 'magic',
    )!;
    const someNeutral = FLOOR2_REWARD_POOL_NON_WEAPON_IDS.slice(0, 2) as string[];
    const mixedBases = [onePhysical, oneMagic, ...someNeutral];
    // weaponIds contains IDs that are NOT in mixedBases
    const absentWeaponIds = new Set([
      'weapon-that-does-not-exist-1',
      'weapon-that-does-not-exist-2',
    ]);
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(mixedBases, absentWeaponIds);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(
      /weaponIds is non-empty.*no base.*matches any weapon ID/,
    );
  });

  it('throws Floor2RewardPoolAuthoringError for weapon sub-pool missing one affinity (new category-check error path)', () => {
    // Construct a pool that passes the outer (full-pool) check but fails the
    // weapon sub-pool check. Use ALL 88 bases — outer check passes because both
    // physical and magic weapons are present. Supply only PHYSICAL weapon IDs as
    // weaponIds so the weapon sub-pool is physical-only; a magic player then sees
    // an empty weapon-aligned partition. The weapon sub-pool affinity check runs
    // before the non-weapon neutrality check, so this error fires first even
    // though magic weapons are re-classified as non-weapons in this fixture.
    const physicalWeaponIds = new Set(
      FLOOR2_REWARD_POOL_STABLE_IDS.filter(
        (id) => getGeneratedEquipmentBaseAffinity(id) === 'physical',
      ),
    );
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(FLOOR2_REWARD_POOL_STABLE_IDS, physicalWeaponIds);
    } catch (caught) {
      err = caught;
    }
    // The outer full-pool check passes: the full pool has both magic and physical
    // weapons, so both affinities are reachable. The weapon sub-pool check fires
    // next — before the non-weapon neutrality check — because it only sees
    // physical weapons: the physical player's non-aligned (magic) side is empty,
    // so "no non-physical weapon candidate" fires first (physical build is checked
    // first in BUILD_AFFINITIES).
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(/weapon sub-pool.*no non-physical weapon candidate/);
  });

  it('throws Floor2RewardPoolAuthoringError when weaponIds is an empty set (regression: empty-set category weighting)', () => {
    // The resolver activates category weighting for any defined weaponIds,
    // including an empty set — an empty set makes the weapon category pool
    // permanently empty, so every weapon-category roll would crash at runtime.
    // The validator must reject an empty weaponIds regardless of the pool.
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(FLOOR2_REWARD_POOL_STABLE_IDS, new Set());
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(/weaponIds is empty/);
  });

  it('throws Floor2RewardPoolAuthoringError when all pool bases are weapons (regression: all-weapon pool non-weapon category crash)', () => {
    // An all-weapon pool means the non-weapon category pool is empty; a
    // non-weapon category roll would always crash at runtime. The validator must
    // reject this configuration.
    const allWeaponIds = new Set<string>(FLOOR2_REWARD_POOL_WEAPON_IDS);
    let err: unknown;
    try {
      validateFloor2RewardPoolTierEligibility(FLOOR2_REWARD_POOL_WEAPON_IDS, allWeaponIds);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Floor2RewardPoolAuthoringError);
    expect((err as Error).message).toMatch(/all bases in the pool are weapons/);
  });

  it('rarityEligibleBaseIds returns all bases for every rarity under the decoupled model (no pre-filtering)', () => {
    // Under the decoupled model, non-armor power is affix-driven and bases
    // are never filtered by their inherent stat bonuses. All bases are
    // eligible for all rarities.
    expect(rarityEligibleBaseIds(FLOOR2_REWARD_POOL_STABLE_IDS, 'common')).toHaveLength(
      FLOOR2_REWARD_POOL_STABLE_IDS.length,
    );
    expect(rarityEligibleBaseIds(FLOOR2_REWARD_POOL_STABLE_IDS, 'uncommon')).toHaveLength(
      FLOOR2_REWARD_POOL_STABLE_IDS.length,
    );
    expect(rarityEligibleBaseIds(FLOOR2_REWARD_POOL_STABLE_IDS, 'rare')).toHaveLength(
      FLOOR2_REWARD_POOL_STABLE_IDS.length,
    );
  });
});

describe('categoryFromRoll — exact threshold contract', () => {
  it('encodes exactly 25% weapon draw weight', () => {
    expect(FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT).toBe(0.25);
  });

  it('returns weapon when roll < weaponWeight and non-weapon otherwise (exact < threshold)', () => {
    const w = FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT;
    expect(categoryFromRoll(0, w)).toBe('weapon');
    expect(categoryFromRoll(w - 1e-9, w)).toBe('weapon');
    expect(categoryFromRoll(w, w)).toBe('non-weapon'); // exactly at threshold → non-weapon
    expect(categoryFromRoll(w + 1e-9, w)).toBe('non-weapon');
    expect(categoryFromRoll(0.999999, w)).toBe('non-weapon');
  });

  it('works for arbitrary weight values at the exact threshold boundary', () => {
    expect(categoryFromRoll(0.5 - 1e-9, 0.5)).toBe('weapon');
    expect(categoryFromRoll(0.5, 0.5)).toBe('non-weapon');
    expect(categoryFromRoll(0, 0)).toBe('non-weapon'); // 0% weapon weight → always non-weapon
    expect(categoryFromRoll(0.999999, 1)).toBe('weapon'); // 100% weapon weight → always weapon
  });

  it('empirically draws at ~25% weapon / ~75% non-weapon over a uniform stream', () => {
    const rng = new SeededRandom(9999);
    const samples = 20_000;
    let weaponCount = 0;
    for (let i = 0; i < samples; i += 1) {
      if (categoryFromRoll(rng.next(), FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT) === 'weapon') {
        weaponCount += 1;
      }
    }
    const observed = weaponCount / samples;
    expect(Math.abs(observed - FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT)).toBeLessThan(0.02);
  });
});

describe('resolveEquipmentRewardBundle — category-weighted selection (weaponIds provided)', () => {
  const WEAPON_ID_SET = new Set<string>(FLOOR2_REWARD_POOL_WEAPON_IDS);

  it('resolves without error from the full 88-entry pool with category weighting for both affinities', () => {
    for (const [i, weaponDef] of [{ id: 'iron-cleaver' }, { id: 'ember-wand' }].entries()) {
      const world = makeWorld(`category-full-pool-${i}`);
      setActiveWeapon(world, getWeaponDef(weaponDef.id)!);
      // Should not throw — both weapon and non-weapon sub-pools are non-empty
      // and their category-specific validation passes at load time.
      expect(() =>
        resolveEquipmentRewardBundle(
          world,
          `ach-${i}`,
          FLOOR2_REWARD_POOL_STABLE_IDS,
          'tier2',
          WEAPON_ID_SET,
        ),
      ).not.toThrow();
    }
  });

  it('is deterministic for the same run key + achievement + tier + affinity', () => {
    const worldA = makeWorld('category-det');
    const worldB = makeWorld('category-det');
    const a = resolveEquipmentRewardBundle(
      worldA,
      'ach-det',
      FLOOR2_REWARD_POOL_STABLE_IDS,
      'tier2',
      WEAPON_ID_SET,
    );
    const b = resolveEquipmentRewardBundle(
      worldB,
      'ach-det',
      FLOOR2_REWARD_POOL_STABLE_IDS,
      'tier2',
      WEAPON_ID_SET,
    );
    expect(b.instanceKeys).toEqual(a.instanceKeys);
    for (let i = 0; i < a.instanceKeys.length; i += 1) {
      expect(getGeneratedEquipmentInstance(worldB, b.instanceKeys[i]!)).toEqual(
        getGeneratedEquipmentInstance(worldA, a.instanceKeys[i]!),
      );
    }
  });

  it('empirically draws ~25% weapon and ~75% non-weapon bases across many run keys', () => {
    const SAMPLES = 400;
    let weaponCount = 0;
    for (let seed = 0; seed < SAMPLES; seed += 1) {
      const world = makeWorld(`category-freq-${seed}`);
      const bundle = resolveEquipmentRewardBundle(
        world,
        'ach-freq',
        FLOOR2_REWARD_POOL_STABLE_IDS,
        'tier2',
        WEAPON_ID_SET,
      );
      const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
      if (WEAPON_ID_SET.has(instance.baseId)) weaponCount += 1;
    }
    const observedWeaponFraction = weaponCount / SAMPLES;
    // Empirical frequency should be close to the authored 25% weight.
    // Allow ±10% variance to keep the test deterministic across seeds.
    expect(
      observedWeaponFraction,
      `weapon fraction ${observedWeaponFraction.toFixed(3)} should be near ${FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT}`,
    ).toBeGreaterThan(FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT - 0.1);
    expect(observedWeaponFraction).toBeLessThan(FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT + 0.1);
  });

  it('category decision and resolved base are consistent: weapon category → weapon base, non-weapon category → non-weapon base', () => {
    // Reconstructs the category decision for each sample using the same
    // deterministic substream key the resolver uses, then asserts that the
    // resolved base matches the expected category. This detects a bug where
    // e.g. the non-weapon pool filter is inverted or the wrong sub-pool is
    // passed to the base-selection draw.
    const NON_WEAPON_SET = new Set<string>(FLOOR2_REWARD_POOL_NON_WEAPON_IDS);
    const RUN_KEY_PREFIX = 'category-nonweapon';
    const ACH_ID = 'ach-nw';
    const TIER = 'tier2';

    for (let seed = 0; seed < 100; seed += 1) {
      const runKey = `${RUN_KEY_PREFIX}-${seed}`;
      const world = makeWorld(runKey);
      const bundle = resolveEquipmentRewardBundle(
        world,
        ACH_ID,
        FLOOR2_REWARD_POOL_STABLE_IDS,
        TIER,
        WEAPON_ID_SET,
      );
      const instance = getGeneratedEquipmentInstance(world, bundle.instanceKeys[0]!)!;
      const isWeapon = WEAPON_ID_SET.has(instance.baseId);
      const isNonWeapon = NON_WEAPON_SET.has(instance.baseId);
      // Every resolved base must be in exactly one category.
      expect(isWeapon !== isNonWeapon, `seed ${seed}: base must be weapon or non-weapon`).toBe(
        true,
      );

      // Reconstruct the category decision using the same substream key the
      // resolver uses: reward-bundle:<version>:<runKey>:<achievementId>:category:<tier>
      const categoryRng = new SeededRandom(
        hashStringToSeed(
          `reward-bundle:${REWARD_BUNDLE_RESOLVER_VERSION}:${runKey}:${ACH_ID}:category:${TIER}`,
        ),
      );
      const expectedCategory = categoryFromRoll(
        categoryRng.next(),
        FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT,
      );

      if (expectedCategory === 'weapon') {
        expect(
          isWeapon,
          `seed ${seed}: category roll was 'weapon' but resolved base "${instance.baseId}" is non-weapon`,
        ).toBe(true);
      } else {
        expect(
          isNonWeapon,
          `seed ${seed}: category roll was 'non-weapon' but resolved base "${instance.baseId}" is weapon`,
        ).toBe(true);
      }
    }
  });

  it('without weaponIds (boss-chest path) still resolves via affinity alignment, unchanged', () => {
    // Boss chest calls omit weaponIds → the old affinity-partitioned draw runs
    // as before. Confirm it still resolves without error for both affinities.
    for (const [i, id] of ['iron-cleaver', 'ember-wand'].entries()) {
      const world = makeWorld(`boss-chest-no-cat-${i}`);
      setActiveWeapon(world, getWeaponDef(id)!);
      expect(() =>
        resolveEquipmentRewardBundle(world, `boss-${i}`, MIXED_BASES, 'tier2'),
      ).not.toThrow();
    }
  });
});
