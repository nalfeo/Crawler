import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_BALANCE_BUILD_IDS,
  EQUIPMENT_DPS_RATIO_MAX,
  EQUIPMENT_DPS_RATIO_MIN,
  formatEquipmentBalanceReport,
  runEquipmentBalanceCohort,
  runGeneratedEquipmentDistributionFixtures,
} from '../../src/bootstrap/equipment-balance-harness.js';
import {
  _GeneratedEquipmentGeneratorError as GeneratedEquipmentGeneratorError,
  generateEquipmentInstance,
} from '../../src/game/generated-equipment-generator.js';
import type {
  GeneratedEquipmentEnhancementLevel,
  GeneratedEquipmentRarity,
} from '../../src/shared/generated-equipment-types.js';
import { getEquipmentDefForItem } from '../../src/shared/equipmentDefs.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function worldFactory(seed: number, runKey: string) {
  return createTestWorld({ seed, generatedEquipmentRunKey: runKey });
}

describe('deterministic equipment balance gate', () => {
  it('keeps both representative-cohort median aggregate-DPS bands within 1.7x-2.3x', () => {
    const report = runEquipmentBalanceCohort(EQUIPMENT_BALANCE_BUILD_IDS, worldFactory);
    const diagnostics = formatEquipmentBalanceReport(report);

    if (!report.passes) {
      throw new Error(diagnostics);
    }
    expect(report.medianLevel1To6).toBeGreaterThanOrEqual(EQUIPMENT_DPS_RATIO_MIN);
    expect(report.medianLevel1To6).toBeLessThanOrEqual(EQUIPMENT_DPS_RATIO_MAX);
    expect(report.medianLevel6To11).toBeGreaterThanOrEqual(EQUIPMENT_DPS_RATIO_MIN);
    expect(report.medianLevel6To11).toBeLessThanOrEqual(EQUIPMENT_DPS_RATIO_MAX);
    expect(report.builds).toHaveLength(5);
    expect(report.builds.map((build) => build.focus)).toEqual([
      'single-target',
      'aoe',
      'cadence/crit',
      'active ability',
      'defense/encumbrance',
    ]);

    const active = report.builds.find((build) => build.buildId === 'active-ability')!;
    expect(active.levels[1].activeAbilityIds).toHaveLength(0);
    expect(active.levels[1].activeAbilityDps).toBe(0);
    expect(active.levels[6].activeAbilityIds).toContain('fireball');
    expect(active.levels[6].activeAbilityDps).toBeGreaterThan(0);
    expect(active.levels[6].weaponAndPassiveDps).toBeGreaterThan(0);
    expect(active.levels[11].activeAbilityIds).toContain('fireball');
    expect(active.levels[11].activeAbilityDps).toBeGreaterThan(0);
    expect(active.levels[11].weaponAndPassiveDps).toBeGreaterThan(0);
    const defensive = report.builds.find((build) => build.buildId === 'defensive-encumbrance')!;
    expect(defensive.levels[11].encumbranceBand).not.toBe('unburdened');
  });

  it('replays identically and is independent of cohort execution order', () => {
    const first = runEquipmentBalanceCohort(EQUIPMENT_BALANCE_BUILD_IDS, worldFactory);
    const replay = runEquipmentBalanceCohort(EQUIPMENT_BALANCE_BUILD_IDS, worldFactory);
    const reversed = runEquipmentBalanceCohort(
      [...EQUIPMENT_BALANCE_BUILD_IDS].reverse(),
      worldFactory,
    );

    expect(replay).toEqual(first);
    expect([...reversed.builds].reverse()).toEqual(first.builds);
    expect(reversed.medianLevel1To6).toBe(first.medianLevel1To6);
    expect(reversed.medianLevel6To11).toBe(first.medianLevel6To11);
  });
});

describe('seeded D1 equipment distribution fixtures', () => {
  it('enforces rarity budgets, legal effects, exact seeded counts, and stable replay', () => {
    const forward = runGeneratedEquipmentDistributionFixtures('forward', worldFactory);
    const replay = runGeneratedEquipmentDistributionFixtures('forward', worldFactory);
    const reversed = runGeneratedEquipmentDistributionFixtures('reverse', worldFactory);
    const budgetByRarity: Readonly<Record<GeneratedEquipmentRarity, number>> = {
      common: 0,
      uncommon: 1,
      rare: 2,
    };
    const rarityScalar: Readonly<Record<GeneratedEquipmentRarity, number>> = {
      common: 1,
      uncommon: 1.05,
      rare: 1.1,
    };
    const baseArmor = getEquipmentDefForItem('iron-breastplate')?.statBonuses.armor ?? 0;

    expect(forward.sampleCount).toBe(54);
    expect(forward.rarityCounts).toEqual({ common: 18, uncommon: 18, rare: 18 });
    expect(forward.enhancementCounts).toEqual({ 0: 24, 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 });
    expect(forward.effectCounts).toEqual({
      fortunate: 8,
      guarded: 5,
      instinctive: 5,
      spellbound: 9,
      tempered: 5,
      vital: 8,
    });
    expect(forward.effectKindCounts).toEqual({
      abilityGrant: 9,
      passiveGrant: 5,
      stat: 26,
    });
    for (const sample of forward.samples) {
      expect(sample.effectUnits).toBe(budgetByRarity[sample.rarity]);
      if (sample.effectIds.includes('tempered')) expect(sample.baseId).toBe('plasma-pistol');
      if (sample.effectIds.includes('guarded')) expect(sample.baseId).toBe('iron-breastplate');
      expect(new Set(sample.effectIds).size).toBe(sample.effectIds.length);
      expect(sample.effectIds.includes('vital') && sample.effectIds.includes('fortunate')).toBe(
        false,
      );
    }
    const commonArmorSample = forward.samples.find(
      (sample) => sample.key === '2101:iron-breastplate:common:0',
    );
    expect(commonArmorSample).toBeDefined();
    expect(commonArmorSample?.inherentValue).toBe(
      Math.floor(baseArmor * 1.5 * rarityScalar.common + 0.5),
    );
    expect(replay.replayKey).toBe(forward.replayKey);
    expect(reversed.replayKey).toBe(forward.replayKey);
  });

  it('applies exact rarity scalars and accepts only enhancement +0 through +5', () => {
    const baseDamage = getWeaponDef('pistol')!.baseDamage;
    const baseArmor = getEquipmentDefForItem('iron-breastplate')!.statBonuses.armor ?? 0;
    const rarityScalar: Readonly<Record<GeneratedEquipmentRarity, number>> = {
      common: 1,
      uncommon: 1.05,
      rare: 1.1,
    };
    for (const rarity of ['common', 'uncommon', 'rare'] as const) {
      const world = worldFactory(77, `rarity-${rarity}`);
      const generated = generateEquipmentInstance(world, {
        baseId: 'plasma-pistol',
        itemLevel: 6,
        rarity,
        enhancementLevel: 0,
      });
      expect(generated.frozen.activeWeaponSnapshot?.baseDamage).toBe(
        Math.floor(baseDamage * 1.5 * rarityScalar[rarity] + 0.5),
      );
      const generatedArmor = generateEquipmentInstance(
        worldFactory(177, `armor-rarity-${rarity}`),
        {
          baseId: 'iron-breastplate',
          itemLevel: 6,
          rarity,
          enhancementLevel: 0,
        },
      );
      const armorEffect = generatedArmor.resolvedEffects.reduce(
        (sum, effect) =>
          'kind' in effect && effect.kind === 'stat' && effect.stat === 'armor'
            ? sum + effect.value
            : sum,
        0,
      );
      expect(generatedArmor.frozen.statBonuses.armor).toBe(
        Math.floor(baseArmor * 1.5 * rarityScalar[rarity] + armorEffect + 0.5),
      );
    }

    for (let enhancement = 0; enhancement <= 5; enhancement += 1) {
      const world = worldFactory(88 + enhancement, `enhancement-${enhancement}`);
      expect(() =>
        generateEquipmentInstance(world, {
          baseId: 'plasma-pistol',
          itemLevel: 6,
          rarity: 'common',
          enhancementLevel: enhancement as GeneratedEquipmentEnhancementLevel,
        }),
      ).not.toThrow();
    }
    const invalidUpperWorld = worldFactory(99, 'enhancement-invalid-upper');
    expect(() =>
      generateEquipmentInstance(invalidUpperWorld, {
        baseId: 'plasma-pistol',
        itemLevel: 6,
        rarity: 'common',
        enhancementLevel: 6 as GeneratedEquipmentEnhancementLevel,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GeneratedEquipmentGeneratorError>>({
        code: 'invalid-request',
      }),
    );
    const invalidNegWorld = worldFactory(100, 'enhancement-invalid-negative');
    expect(() =>
      generateEquipmentInstance(invalidNegWorld, {
        baseId: 'plasma-pistol',
        itemLevel: 6,
        rarity: 'common',
        enhancementLevel: -1 as GeneratedEquipmentEnhancementLevel,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GeneratedEquipmentGeneratorError>>({
        code: 'invalid-request',
      }),
    );
    const invalidRarityWorld = worldFactory(101, 'rarity-invalid');
    expect(() =>
      generateEquipmentInstance(invalidRarityWorld, {
        baseId: 'plasma-pistol',
        itemLevel: 6,
        rarity: 'legendary' as GeneratedEquipmentRarity,
        enhancementLevel: 0,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GeneratedEquipmentGeneratorError>>({
        code: 'invalid-request',
      }),
    );
  });
});
