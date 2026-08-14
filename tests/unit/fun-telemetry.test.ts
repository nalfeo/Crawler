import { describe, expect, it } from 'vitest';
import {
  createFunTelemetryCollector,
  recordFunTelemetryActivation,
} from '../../src/core/fun-telemetry.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { generatedEquipmentFunCatalogKey } from '../../src/game/ai/headless-fun-telemetry.js';

describe('fun telemetry collector', () => {
  it('is a no-op when disabled and de-duplicates owning sources when enabled', () => {
    const world = createTestWorld();
    expect(() => recordFunTelemetryActivation(world, ['weapon:sword'])).not.toThrow();

    world.funTelemetry = createFunTelemetryCollector();
    recordFunTelemetryActivation(world, ['spell:heal', 'spell:heal', 'weapon:sword']);

    expect(world.funTelemetry.activations).toEqual([
      {
        activationId: 1,
        itemSources: ['spell:heal', 'weapon:sword'],
      },
    ]);
  });

  it('normalizes generated catalog identity across runs and rolled numeric values', () => {
    const create = (runKey: string, itemLevel: number, value: number) => {
      const world = createTestWorld({ generatedEquipmentRunKey: runKey });
      return createGeneratedEquipmentInstance(world, {
        baseId: 'armor.ceremonial-coat',
        itemLevel,
        rarity: 'uncommon',
        enhancementLevel: 0,
        resolvedEffects: [
          {
            schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
            effectId: `rolled-${value}`,
            effectOrdinal: 0,
            unitCost: 1,
            kind: 'stat',
            stat: 'armor',
            operation: 'add',
            value,
          },
        ],
        frozen: {
          schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
          displayName: 'Rolled Coat',
          artKey: 'armor.ceremonial-coat',
          slots: ['chest'],
          tags: ['armor'],
          weightLb: value,
          statBonuses: { armor: value },
          abilityGrants: [],
          passiveGrants: [],
          activeWeaponSnapshot: null,
        },
      });
    };

    expect(generatedEquipmentFunCatalogKey(create('fun-a', 2, 1))).toBe(
      generatedEquipmentFunCatalogKey(create('fun-b', 9, 7)),
    );
  });
});
