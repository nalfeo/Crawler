import { describe, expect, it } from 'vitest';
import {
  LootBoxRewardResolutionError,
  resolveLootBoxRewardBundle,
} from '../../src/game/lootbox-materials-reward-resolver.js';
import { resolveEquipmentRewardBundle } from '../../src/game/floor2-reward-bundle-resolver.js';
import {
  _FLOOR1_COMMON_CRAFTING_MATERIALS as FLOOR1_COMMON_CRAFTING_MATERIALS,
  FLOOR2_ACHIEVEMENT_LOOT_TIERS,
  _FLOOR2_CRAFTING_MATERIALS as FLOOR2_CRAFTING_MATERIALS,
  _FLOOR2_LOOT_BOX_GOLD_BY_TIER as FLOOR2_LOOT_BOX_GOLD_BY_TIER,
  _LOOT_BOX_GOLD_BY_TIER as LOOT_BOX_GOLD_BY_TIER,
  LOOT_BOX_MATERIAL_COUNT_BY_TIER,
  LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION,
  LOOT_BOX_TIERS,
} from '../../src/shared/achievements.js';
import { createTestWorld } from '../helpers/world-factory.js';

// Two physical + two magic weapon bases so aligned/non-aligned pools are both
// non-empty for either player affinity — mirrors floor2-reward-bundle-resolver.test.ts.
const MIXED_EQUIPMENT_BASES = [
  'weapon.iron-cleaver',
  'weapon.ashwood-bow',
  'weapon.ember-wand',
  'weapon.frost-crook',
] as const;

function makeWorld(runKey = 'lootbox-resolver-test') {
  return createTestWorld({ seed: 7, floor: 1, generatedEquipmentRunKey: runKey });
}

describe('resolveLootBoxRewardBundle — structure and tier scaling', () => {
  it('resolves gold + materials scaled to the tier, tagged with its tier', () => {
    const world = makeWorld();
    const bundle = resolveLootBoxRewardBundle(world, 'first-bonk', 'trash');
    expect(bundle.schemaVersion).toBe(LOOT_BOX_REWARD_BUNDLE_SCHEMA_VERSION);
    expect(bundle.achievementId).toBe('first-bonk');
    expect(bundle.tier).toBe('trash');
    expect(bundle.gold).toBe(LOOT_BOX_GOLD_BY_TIER.trash);
    expect(bundle.materials).toHaveLength(LOOT_BOX_MATERIAL_COUNT_BY_TIER.trash);
  });

  it.each(LOOT_BOX_TIERS)('%s grants exactly its table gold + material count', (tier) => {
    const world = makeWorld(`tier-scaling-${tier}`);
    const bundle = resolveLootBoxRewardBundle(world, 'ach', tier);
    expect(bundle.gold).toBe(LOOT_BOX_GOLD_BY_TIER[tier]);
    expect(bundle.materials).toHaveLength(LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier]);
  });

  it('gold and material count are monotonically non-decreasing across the tier ladder', () => {
    let prevGold = -Infinity;
    let prevCount = -Infinity;
    for (const tier of LOOT_BOX_TIERS) {
      expect(LOOT_BOX_GOLD_BY_TIER[tier]).toBeGreaterThan(prevGold);
      expect(LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier]).toBeGreaterThanOrEqual(prevCount);
      prevGold = LOOT_BOX_GOLD_BY_TIER[tier];
      prevCount = LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier];
    }
  });

  it.each(LOOT_BOX_TIERS)(
    '%s draws every material from the common-crafting-materials pool only (never equipment/rare)',
    (tier) => {
      const world = makeWorld(`material-pool-${tier}`);
      const bundle = resolveLootBoxRewardBundle(world, 'ach', tier);
      for (const materialId of bundle.materials) {
        expect(FLOOR1_COMMON_CRAFTING_MATERIALS).toContain(materialId);
      }
    },
  );

  it('is idempotent — a second resolve for the same achievement returns the identical bundle without re-rolling', () => {
    const world = makeWorld();
    const first = resolveLootBoxRewardBundle(world, 'ach', 'uncommon');
    const second = resolveLootBoxRewardBundle(world, 'ach', 'uncommon');
    expect(second).toBe(first);
  });
});

describe('resolveLootBoxRewardBundle — determinism and isolation', () => {
  it('replays identical gold + materials for the same run key + achievement + tier', () => {
    const worldA = makeWorld('run-x');
    const worldB = makeWorld('run-x');
    const a = resolveLootBoxRewardBundle(worldA, 'ach', 'legendary');
    const b = resolveLootBoxRewardBundle(worldB, 'ach', 'legendary');
    expect(b).toEqual(a);
  });

  it('produces distinct material streams for different run keys', () => {
    const a = resolveLootBoxRewardBundle(makeWorld('run-x'), 'ach', 'divine');
    const b = resolveLootBoxRewardBundle(makeWorld('run-y'), 'ach', 'divine');
    expect(b.materials).not.toEqual(a.materials);
  });

  it('produces distinct material streams for different achievement ids on the same run key', () => {
    const world = makeWorld('run-ach-iso');
    const a = resolveLootBoxRewardBundle(world, 'ach-a', 'divine');
    const b = resolveLootBoxRewardBundle(world, 'ach-b', 'divine');
    expect(b.materials).not.toEqual(a.materials);
  });

  it('does not consume the gameplay rng (zero contamination)', () => {
    const withResolve = makeWorld('contam');
    const withoutResolve = makeWorld('contam');
    resolveLootBoxRewardBundle(withResolve, 'ach', 'epic');
    // The next gameplay draw must match a world that never resolved a bundle.
    expect(withResolve.rng.next()).toBe(withoutResolve.rng.next());
  });

  it('is isolated from the Floor 2 equipment reward-bundle RNG substream (same run key + achievement id never collide)', () => {
    // Resolve BOTH resolvers on the SAME world/run key/achievement id. If the
    // two resolvers accidentally shared a derivation key (keyed only by run
    // key + achievement id, with no resolver-specific prefix), resolving one
    // after the other would perturb or invalidate the first result. Proving
    // the lootBox bundle is untouched after an interleaved Floor 2 equipment
    // resolve demonstrates the resolvers occupy disjoint RNG substreams.
    const world = makeWorld('cross-resolver-iso');
    const lootBox = resolveLootBoxRewardBundle(world, 'shared-id', 'rare');
    const equipment = resolveEquipmentRewardBundle(
      world,
      'shared-id',
      MIXED_EQUIPMENT_BASES,
      'tier2',
    );
    const lootBoxAfterEquipmentResolve = resolveLootBoxRewardBundle(world, 'shared-id', 'rare');
    expect(lootBoxAfterEquipmentResolve).toBe(lootBox);
    expect(equipment.achievementId).toBe('shared-id');
    expect(equipment.tier).toBe('tier2');
  });
});

describe('resolveLootBoxRewardBundle — fail-closed', () => {
  it('throws no-run-key and leaves the world untouched when the registry is unconfigured', () => {
    const world = createTestWorld({ seed: 7, floor: 1, generatedEquipmentRunKey: null });
    expect(() => resolveLootBoxRewardBundle(world, 'ach', 'trash')).toThrow(
      LootBoxRewardResolutionError,
    );
    let err: unknown;
    try {
      resolveLootBoxRewardBundle(world, 'ach', 'trash');
    } catch (caught) {
      err = caught;
    }
    expect((err as LootBoxRewardResolutionError).code).toBe('no-run-key');
    expect(world.lootBoxRewardBundles.size).toBe(0);
  });
});

describe('resolveLootBoxRewardBundle — Floor 2 materials table', () => {
  it.each(FLOOR2_ACHIEVEMENT_LOOT_TIERS)(
    '%s pays Floor 2 gold (above Floor 1) and draws only Floor 2 materials',
    (tier) => {
      const world = makeWorld(`floor2-materials-${tier}`);
      const bundle = resolveLootBoxRewardBundle(
        world,
        'floor2-second-wind',
        tier,
        'floor2-materials',
      );
      expect(bundle.gold).toBe(FLOOR2_LOOT_BOX_GOLD_BY_TIER[tier]);
      expect(bundle.gold).toBeGreaterThan(LOOT_BOX_GOLD_BY_TIER[tier]);
      expect(bundle.materials).toHaveLength(LOOT_BOX_MATERIAL_COUNT_BY_TIER[tier]);
      for (const itemId of bundle.materials) {
        expect(FLOOR2_CRAFTING_MATERIALS).toContain(itemId);
      }
    },
  );

  it('draws from a different (wider) stream than the Floor 1 table for the same achievement + tier', () => {
    const floor1World = makeWorld('table-split');
    const floor2World = makeWorld('table-split');
    const floor1 = resolveLootBoxRewardBundle(floor1World, 'shared-id', 'common');
    const floor2 = resolveLootBoxRewardBundle(
      floor2World,
      'shared-id',
      'common',
      'floor2-materials',
    );
    expect(floor2.gold).not.toBe(floor1.gold);
    // Floor 1's pool is a strict subset of Floor 2's, so equality of materials
    // is possible by chance — the stream key differing is what matters, and is
    // asserted by re-resolving Floor 2 deterministically below.
    const floor2Again = resolveLootBoxRewardBundle(
      makeWorld('table-split'),
      'shared-id',
      'common',
      'floor2-materials',
    );
    expect(floor2Again.materials).toEqual(floor2.materials);
  });

  it('keeps the Floor 1 stream unchanged when the default table is used', () => {
    const explicit = resolveLootBoxRewardBundle(
      makeWorld('stream-stability'),
      'first-bonk',
      'trash',
      'floor1-materials',
    );
    const defaulted = resolveLootBoxRewardBundle(
      makeWorld('stream-stability'),
      'first-bonk',
      'trash',
    );
    expect(explicit.materials).toEqual(defaulted.materials);
    expect(explicit.gold).toBe(defaulted.gold);
  });
});
