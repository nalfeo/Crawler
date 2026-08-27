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

interface DistributionSummary {
  readonly rarityCounts: Readonly<Record<GeneratedEquipmentRarity, number>>;
  readonly enhancementCounts: Readonly<Record<number, number>>;
  readonly effectCounts: Readonly<Record<string, number>>;
}

const FIXTURE_INDEX_SEED_STEP = 17;
const RARITIES: readonly GeneratedEquipmentRarity[] = ['common', 'uncommon', 'rare'];
const EFFECT_POOL = ['crit-boost', 'swift-stride', 'sturdy-hide', 'vampiric-edge', 'arcane-surge'];

function deriveFixtureSeed(baseSeed: number, index: number): number {
  // Prime step (17) keeps adjacent fixture streams decorrelated while
  // preserving deterministic replay for a fixed (seed, index) pair.
  return baseSeed + index * FIXTURE_INDEX_SEED_STEP;
}

function inputForIndex(
  seed: number,
  index: number,
  rarityEffectUnits: Readonly<Record<GeneratedEquipmentRarity, 0 | 1 | 2>>,
): GeneratedEquipmentCreateInputV1 {
  const rng = new SeededRandom(deriveFixtureSeed(seed, index));
  const rarity = RARITIES[rng.nextInt(0, RARITIES.length - 1)]!;
  const enhancementLevel = rng.nextInt(ENHANCEMENT_MIN, ENHANCEMENT_MAX) as 0 | 1 | 2 | 3 | 4 | 5;
  const units = rarityEffectUnits[rarity];
  const available = [...EFFECT_POOL];
  const resolvedEffects: Array<GeneratedEquipmentCreateInputV1['resolvedEffects'][number]> = [];
  for (let i = 0; i < units; i += 1) {
    const pickIndex = rng.nextInt(0, available.length - 1);
    const effectId = available[pickIndex]!;
    available.splice(pickIndex, 1);
    resolvedEffects.push({
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId,
      effectOrdinal: i,
      unitCost: 1,
      kind: 'stat',
      stat: 'armor',
      operation: 'add',
      value: 1 + i,
    });
  }
  return {
    baseId: `distribution.fixture.${index}`,
    itemLevel: 6,
    rarity,
    enhancementLevel,
    resolvedEffects,
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `Distribution Fixture ${index}`,
      artKey: `equipment.distribution.${index}`,
      slots: ['ring1'],
      tags: ['fixture'],
      weightLb: 1,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  };
}

function summarize(
  fixtures: readonly {
    rarity: GeneratedEquipmentRarity;
    enhancementLevel: number;
    resolvedEffects: readonly { effectId: string }[];
  }[],
): DistributionSummary {
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
    for (const effect of fixture.resolvedEffects) {
      const effectId = effect.effectId;
      effectCounts[effectId] = (effectCounts[effectId] ?? 0) + 1;
    }
  }
  return { rarityCounts, enhancementCounts, effectCounts };
}

function buildGeneratedInstances(seed: number, count: number, runKey: string) {
  const world = createTestWorld({ seed, generatedEquipmentRunKey: runKey });
  const rarityEffectUnits = world.generatedEquipmentRegistry.generationPolicy.rarityEffectUnits;
  return Array.from({ length: count }, (_, index) =>
    createGeneratedEquipmentInstance(world, inputForIndex(seed, index, rarityEffectUnits)),
  );
}

describe('deterministic generated-equipment distribution fixtures', () => {
  it('enforces D1 rarity legality, +0..+5 enhancement bounds, and rarity effect budgets', () => {
    const instances = buildGeneratedInstances(1567, 48, 'distribution-fixture-legality');
    for (const instance of instances) {
      expect(['common', 'uncommon', 'rare']).toContain(instance.rarity);
      expect(instance.enhancementLevel).toBeGreaterThanOrEqual(ENHANCEMENT_MIN);
      expect(instance.enhancementLevel).toBeLessThanOrEqual(ENHANCEMENT_MAX);
      expect(instance.resolvedEffects).toHaveLength(RARITY_EFFECT_BUDGET[instance.rarity]);
      expect(instance.frozen.schemaVersion).toBe(FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION);
    }
  });

  it('replays stably and preserves seeded rarity/effect distributions within fixed tolerances', () => {
    const instancesA = buildGeneratedInstances(20260719, 120, 'distribution-fixture-replay');
    const instancesB = buildGeneratedInstances(20260719, 120, 'distribution-fixture-replay');
    const instancesReordered = [...instancesA].reverse();
    const summary = summarize(instancesA);
    const summaryReplay = summarize(instancesB);
    const summaryReordered = summarize(instancesReordered);

    expect(instancesB).toEqual(instancesA);
    expect(summaryReplay).toEqual(summary);
    expect(summaryReordered).toEqual(summary);

    // Expected seeded distribution envelope for seed=20260719, n=120.
    expect(summary.rarityCounts.common).toBeGreaterThanOrEqual(30);
    expect(summary.rarityCounts.common).toBeLessThanOrEqual(50);
    expect(summary.rarityCounts.uncommon).toBeGreaterThanOrEqual(30);
    expect(summary.rarityCounts.uncommon).toBeLessThanOrEqual(50);
    expect(summary.rarityCounts.rare).toBeGreaterThanOrEqual(30);
    expect(summary.rarityCounts.rare).toBeLessThanOrEqual(50);

    const topEffects = Object.entries(summary.effectCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    expect(topEffects.length).toBe(3);
    expect(topEffects[0]?.[1] ?? 0).toBeGreaterThan(15);
    expect(topEffects[2]?.[1] ?? 0).toBeGreaterThan(6);
  });
});
