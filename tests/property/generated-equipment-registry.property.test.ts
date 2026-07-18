import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentRarity,
  type ResolvedEquipmentEffectV1,
} from '../../src/shared/generated-equipment-types.js';
import { canonicalJson, sha256Hex } from '../../src/shared/canonical-json.js';
import {
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
} from '../../src/core/generated-equipment-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

const runKeyArbitrary = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const rarityArbitrary = fc.constantFrom<GeneratedEquipmentRarity>('common', 'uncommon', 'rare');

function effectsFor(rarity: GeneratedEquipmentRarity): readonly ResolvedEquipmentEffectV1[] {
  const count = rarity === 'common' ? 0 : rarity === 'uncommon' ? 1 : 2;
  return Array.from({ length: count }, (_, effectOrdinal) => ({
    schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
    effectId: `effect-${effectOrdinal}`,
    effectOrdinal,
    unitCost: 1 as const,
    kind: 'stat' as const,
    stat: 'armor' as const,
    operation: 'add' as const,
    value: effectOrdinal + 1,
  }));
}

function inputFor(
  rarity: GeneratedEquipmentRarity,
  itemLevel: number,
): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: 'weapon.iron-cleaver',
    itemLevel,
    rarity,
    enhancementLevel: 0,
    resolvedEffects: effectsFor(rarity),
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Property Sword',
      artKey: 'weapon.iron-cleaver',
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 3,
      statBonuses: { armor: itemLevel },
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: null,
    },
  };
}

describe('generated equipment registry properties', () => {
  it('produces stable distinct keys for every valid run key and ordinal', () => {
    fc.assert(
      fc.property(runKeyArbitrary, fc.integer({ min: 0, max: 100_000 }), (runKey, ordinal) => {
        expect(generatedEquipmentInstanceKey(runKey, ordinal)).toBe(
          generatedEquipmentInstanceKey(runKey, ordinal),
        );
        expect(generatedEquipmentInstanceKey(runKey, ordinal)).not.toBe(
          generatedEquipmentInstanceKey(runKey, ordinal + 1),
        );
      }),
    );
  });

  it('canonicalizes every insertion order to the same SHA-256 digest', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.oneof(fc.integer(), fc.boolean(), fc.string()),
        ),
        (record) => {
          const entries = Object.entries(record);
          const forward = Object.fromEntries(entries);
          const reversed = Object.fromEntries([...entries].reverse());
          expect(canonicalJson(forward)).toBe(canonicalJson(reversed));
          expect(sha256Hex(canonicalJson(forward))).toBe(sha256Hex(canonicalJson(reversed)));
        },
      ),
    );
  });

  it('creates byte-identical records from equal world configuration and inputs', () => {
    fc.assert(
      fc.property(
        runKeyArbitrary,
        rarityArbitrary,
        fc.integer({ min: 1, max: 100 }),
        (runKey, rarity, itemLevel) => {
          const left = createTestWorld({ generatedEquipmentRunKey: runKey });
          const right = createTestWorld({ generatedEquipmentRunKey: runKey });
          const input = inputFor(rarity, itemLevel);

          const leftInstance = createGeneratedEquipmentInstance(left, input);
          const rightInstance = createGeneratedEquipmentInstance(right, input);

          expect(rightInstance).toEqual(leftInstance);
          expect(rightInstance.fingerprint).toBe(leftInstance.fingerprint);
          expect(Object.isFrozen(leftInstance.frozen.statBonuses)).toBe(true);
        },
      ),
    );
  });
});
