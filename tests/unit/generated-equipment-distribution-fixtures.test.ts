import { describe, expect, it } from 'vitest';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import {
  ENHANCEMENT_MAX,
  ENHANCEMENT_MIN,
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  RARITY_EFFECT_BUDGET,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentRarity,
} from '../../src/shared/generated-equipment-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';

interface DistributionFixture {
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: 0 | 1 | 2 | 3 | 4 | 5;
  readonly effectIds: readonly string[];
}

interface DistributionSummary {
  readonly rarityCounts: Readonly<Record<GeneratedEquipmentRarity, number>>;
  readonly enhancementCounts: Readonly<Record<number, number>>;
  readonly effectCounts: Readonly<Record<string, number>>;
}

const FIXTURE_INDEX_SEED_STEP = 17;

function chooseRarity(rng: SeededRandom): GeneratedEquipmentRarity {
  const roll = rng.next();
  if (roll < 0.62) return 'common';
  if (roll < 0.9) return 'uncommon';
  return 'rare';
}

function chooseEnhancement(
  rng: SeededRandom,
  rarity: GeneratedEquipmentRarity,
): 0 | 1 | 2 | 3 | 4 | 5 {
  if (rarity === 'common') return 0;
  if (rarity === 'uncommon') return (1 + rng.nextInt(0, 2)) as 1 | 2 | 3;
  return (3 + rng.nextInt(0, 2)) as 3 | 4 | 5;
}

function effectPoolForRarity(rarity: GeneratedEquipmentRarity): readonly string[] {
  if (rarity === 'common') return [];
  if (rarity === 'uncommon') return ['crit-boost', 'swift-stride', 'sturdy-hide'];
  return ['crit-boost', 'swift-stride', 'sturdy-hide', 'vampiric-edge', 'arcane-surge'];
}

function deriveFixtureSeed(baseSeed: number, index: number): number {
  // Prime step (17) keeps adjacent fixture streams decorrelated while
  // preserving deterministic replay for a fixed (seed, index) pair.
  return baseSeed + index * FIXTURE_INDEX_SEED_STEP;
}

function fixtureForIndex(seed: number, index: number): DistributionFixture {
  const rng = new SeededRandom(deriveFixtureSeed(seed, index));
  const rarity = chooseRarity(rng);
  const enhancementLevel = chooseEnhancement(rng, rarity);
  const units = RARITY_EFFECT_BUDGET[rarity];
  const pool = effectPoolForRarity(rarity);
  const effectIds: string[] = [];
  const available = [...pool];
  for (let i = 0; i < units; i += 1) {
    const pickIndex = rng.nextInt(0, available.length - 1);
    effectIds.push(available[pickIndex]!);
    available.splice(pickIndex, 1);
  }
  return { rarity, enhancementLevel, effectIds };
}

function toInput(index: number, fixture: DistributionFixture): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: `distribution.fixture.${index}`,
    itemLevel: 6,
    rarity: fixture.rarity,
    enhancementLevel: fixture.enhancementLevel,
    resolvedEffects: fixture.effectIds.map((effectId, effectOrdinal) => ({
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId,
      effectOrdinal,
      unitCost: 1 as const,
      kind: 'stat' as const,
      stat: 'armor' as const,
      operation: 'add' as const,
      value: 1 + effectOrdinal,
    })),
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `Distribution Fixture ${index}`,
      artKey: `equipment.distribution.${index}`,
      slots: ['ringLeft'],
      tags: ['fixture'],
      weightLb: 1,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  };
}

function summarize(fixtures: readonly DistributionFixture[]): DistributionSummary {
  const rarityCounts: Record<GeneratedEquipmentRarity, number> = {
    common: 0,
    uncommon: 0,
    rare: 0,
  };
  const enhancementCounts: Record<number, number> = {};
  const effectCounts: Record<string, number> = {};
  for (const fixture of fixtures) {
    rarityCounts[fixture.rarity] += 1;
    enhancementCounts[fixture.enhancementLevel] =
      (enhancementCounts[fixture.enhancementLevel] ?? 0) + 1;
    for (const effectId of fixture.effectIds) {
      effectCounts[effectId] = (effectCounts[effectId] ?? 0) + 1;
    }
  }
  return { rarityCounts, enhancementCounts, effectCounts };
}

function buildFixtureSet(seed: number, count: number): readonly DistributionFixture[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => fixtureForIndex(seed, index)));
}

describe('deterministic generated-equipment distribution fixtures', () => {
  it('enforces D1 rarity legality, +0..+5 enhancement bounds, and rarity effect budgets', () => {
    const fixtures = buildFixtureSet(1567, 48);
    const world = createTestWorld({ generatedEquipmentRunKey: 'distribution-fixture-legality' });
    for (const [index, fixture] of fixtures.entries()) {
      expect(['common', 'uncommon', 'rare']).toContain(fixture.rarity);
      expect(fixture.enhancementLevel).toBeGreaterThanOrEqual(ENHANCEMENT_MIN);
      expect(fixture.enhancementLevel).toBeLessThanOrEqual(ENHANCEMENT_MAX);
      expect(fixture.effectIds.length).toBe(RARITY_EFFECT_BUDGET[fixture.rarity]);

      const instance = createGeneratedEquipmentInstance(world, toInput(index, fixture));
      expect(instance.rarity).toBe(fixture.rarity);
      expect(instance.enhancementLevel).toBe(fixture.enhancementLevel);
      expect(instance.resolvedEffects).toHaveLength(RARITY_EFFECT_BUDGET[fixture.rarity]);
    }
  });

  it('replays stably and preserves seeded rarity/effect distributions within fixed tolerances', () => {
    const fixturesA = buildFixtureSet(20260719, 120);
    const fixturesB = buildFixtureSet(20260719, 120);
    const fixturesReordered = [...fixturesA].reverse();
    const summary = summarize(fixturesA);
    const summaryReplay = summarize(fixturesB);
    const summaryReordered = summarize(fixturesReordered);

    expect(fixturesB).toEqual(fixturesA);
    expect(summaryReplay).toEqual(summary);
    expect(summaryReordered).toEqual(summary);

    // Expected seeded distribution envelope for seed=20260719, n=120.
    expect(summary.rarityCounts.common).toBeGreaterThanOrEqual(64);
    expect(summary.rarityCounts.common).toBeLessThanOrEqual(84);
    expect(summary.rarityCounts.uncommon).toBeGreaterThanOrEqual(26);
    expect(summary.rarityCounts.uncommon).toBeLessThanOrEqual(50);
    expect(summary.rarityCounts.rare).toBeGreaterThanOrEqual(6);
    expect(summary.rarityCounts.rare).toBeLessThanOrEqual(22);

    const topEffects = Object.entries(summary.effectCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    expect(topEffects.length).toBe(3);
    expect(topEffects[0]?.[1] ?? 0).toBeGreaterThan(15);
    expect(topEffects[2]?.[1] ?? 0).toBeGreaterThan(6);
  });
});
