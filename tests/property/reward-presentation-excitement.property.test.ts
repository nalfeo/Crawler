import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { LOOT_BOX_TIERS, type LootBoxTier } from '../../src/shared/achievements.js';
import {
  EQUIPMENT_REWARD_TIERS,
  type EquipmentRewardTier,
  type GeneratedEquipmentRarity,
} from '../../src/shared/generated-equipment-types.js';
import {
  computeEquipmentExcitement,
  computeLootBoxExcitement,
  computeRewardExcitement,
  highestGeneratedEquipmentRarity,
  type ResolvedRewardPresentation,
} from '../../src/shared/reward-presentation.js';

const RARITY_ORDER: readonly GeneratedEquipmentRarity[] = ['common', 'uncommon', 'rare'];

const lootBoxTierArb = fc.constantFrom(...LOOT_BOX_TIERS);
const equipmentTierArb = fc.constantFrom(...EQUIPMENT_REWARD_TIERS);
const rarityArb = fc.constantFrom(...RARITY_ORDER);

describe('reward-presentation excitement (property-based)', () => {
  it('lootBox excitement is a strict, deterministic function of tier alone with zero rarity contribution', () => {
    fc.assert(
      fc.property(lootBoxTierArb, (tier) => {
        const a = computeLootBoxExcitement(tier);
        const b = computeLootBoxExcitement(tier);
        expect(a).toEqual(b); // deterministic, pure
        expect(a.rarityWeight).toBe(0);
        expect(a.score).toBe(a.tierWeight);
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('lootBox excitement score is monotonically non-decreasing as tier index increases', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: LOOT_BOX_TIERS.length - 1 }),
        fc.integer({ min: 0, max: LOOT_BOX_TIERS.length - 1 }),
        (i, j) => {
          fc.pre(i <= j);
          const lower = computeLootBoxExcitement(LOOT_BOX_TIERS[i] as LootBoxTier);
          const higher = computeLootBoxExcitement(LOOT_BOX_TIERS[j] as LootBoxTier);
          expect(higher.score).toBeGreaterThanOrEqual(lower.score);
        },
      ),
    );
  });

  it('equipment excitement is deterministic and bounded in [0,1]', () => {
    fc.assert(
      fc.property(equipmentTierArb, rarityArb, (tier, rarity) => {
        const a = computeEquipmentExcitement(tier, rarity);
        const b = computeEquipmentExcitement(tier, rarity);
        expect(a).toEqual(b);
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('equipment excitement scales independently: increasing tier (rarity fixed) never decreases score', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: EQUIPMENT_REWARD_TIERS.length - 1 }),
        fc.integer({ min: 0, max: EQUIPMENT_REWARD_TIERS.length - 1 }),
        rarityArb,
        (i, j, rarity) => {
          fc.pre(i <= j);
          const lower = computeEquipmentExcitement(
            EQUIPMENT_REWARD_TIERS[i] as EquipmentRewardTier,
            rarity,
          );
          const higher = computeEquipmentExcitement(
            EQUIPMENT_REWARD_TIERS[j] as EquipmentRewardTier,
            rarity,
          );
          expect(higher.score).toBeGreaterThanOrEqual(lower.score);
        },
      ),
    );
  });

  it('equipment excitement scales independently: increasing rarity (tier fixed) never decreases score', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: RARITY_ORDER.length - 1 }),
        fc.integer({ min: 0, max: RARITY_ORDER.length - 1 }),
        equipmentTierArb,
        (i, j, tier) => {
          fc.pre(i <= j);
          const lower = computeEquipmentExcitement(tier, RARITY_ORDER[i]!);
          const higher = computeEquipmentExcitement(tier, RARITY_ORDER[j]!);
          expect(higher.score).toBeGreaterThanOrEqual(lower.score);
        },
      ),
    );
  });

  it('hard-contract example: tier2+common is strictly less exciting than tier2+uncommon', () => {
    const common = computeEquipmentExcitement('tier2', 'common');
    const uncommon = computeEquipmentExcitement('tier2', 'uncommon');
    expect(common.score).toBeLessThan(uncommon.score);
    expect(common.bucket).not.toBe(uncommon.bucket);
  });

  it('highestGeneratedEquipmentRarity returns the max rarity by canonical order, or null for empty input', () => {
    fc.assert(
      fc.property(fc.array(rarityArb, { minLength: 1, maxLength: 6 }), (rarities) => {
        const highest = highestGeneratedEquipmentRarity(rarities);
        expect(highest).not.toBeNull();
        for (const r of rarities) {
          expect(RARITY_ORDER.indexOf(highest!)).toBeGreaterThanOrEqual(RARITY_ORDER.indexOf(r));
        }
      }),
    );
    expect(highestGeneratedEquipmentRarity([])).toBeNull();
  });

  it('computeRewardExcitement dispatches by presentation kind and matches the direct tier/rarity computation', () => {
    fc.assert(
      fc.property(lootBoxTierArb, fc.integer({ min: 0, max: 500 }), (tier, gold) => {
        const presentation: ResolvedRewardPresentation = {
          kind: 'lootBox',
          tier,
          gold,
          materials: [],
        };
        expect(computeRewardExcitement(presentation, [])).toEqual(computeLootBoxExcitement(tier));
      }),
    );

    fc.assert(
      fc.property(
        equipmentTierArb,
        fc.array(rarityArb, { minLength: 1, maxLength: 4 }),
        (tier, rarities) => {
          const presentation: ResolvedRewardPresentation = {
            kind: 'equipment',
            tier,
            instanceKeys: rarities.map((_, idx) => `gei:v1:lab:${idx}` as const),
          };
          const highest = highestGeneratedEquipmentRarity(rarities)!;
          expect(computeRewardExcitement(presentation, rarities)).toEqual(
            computeEquipmentExcitement(tier, highest),
          );
        },
      ),
    );
  });

  it('computeRewardExcitement fails closed (null) for an equipment presentation with no resolvable rarities', () => {
    const presentation: ResolvedRewardPresentation = {
      kind: 'equipment',
      tier: 'tier1',
      instanceKeys: [],
    };
    expect(computeRewardExcitement(presentation, [])).toBeNull();
  });
});
