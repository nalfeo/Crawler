import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  createActiveWeaponSnapshotInput,
  createGeneratedEquipmentInstance,
} from '../../src/core/generated-equipment-registry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type ActiveWeaponCombatOverridesV1,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const overridesArbitrary = fc.record({
  baseDamage: fc.integer({ min: 0, max: 10_000 }),
  cooldownMs: fc.integer({ min: 1, max: 60_000 }),
  range: fc.integer({ min: 0, max: 1_000 }),
  projectileSpeed: fc.integer({ min: 0, max: 1_000 }),
  pierce: fc.integer({ min: 0, max: 255 }),
  bounceCount: fc.integer({ min: 0, max: 255 }),
  goreFactor: fc.double({ min: 0, max: 1, noNaN: true }),
  baseAccuracy: fc.double({ min: 0, max: 1, noNaN: true }),
}) satisfies fc.Arbitrary<ActiveWeaponCombatOverridesV1>;

function inputFor(overrides: ActiveWeaponCombatOverridesV1): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: 'weapon.generated-pistol',
    itemLevel: 1,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Generated Pistol',
      artKey: 'weapon.generated-pistol',
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 2,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: createActiveWeaponSnapshotInput('pistol', { ...overrides }),
    },
  };
}

describe('active weapon snapshot properties', () => {
  it('produces byte-identical snapshots from equal registry identity and overrides', () => {
    fc.assert(
      fc.property(overridesArbitrary, (overrides) => {
        const left = createTestWorld({ generatedEquipmentRunKey: 'snapshot-property' });
        const right = createTestWorld({ generatedEquipmentRunKey: 'snapshot-property' });

        const leftSnapshot = createGeneratedEquipmentInstance(left, inputFor(overrides)).frozen
          .activeWeaponSnapshot;
        const rightSnapshot = createGeneratedEquipmentInstance(right, inputFor(overrides)).frozen
          .activeWeaponSnapshot;

        expect(rightSnapshot).toEqual(leftSnapshot);
        expect(rightSnapshot?.fingerprint).toBe(leftSnapshot?.fingerprint);
        expect(Object.isFrozen(leftSnapshot)).toBe(true);
      }),
    );
  });

  it('changes the fingerprint when a combat override changes under the same identity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_999 }),
        fc.integer({ min: 1, max: 10_000 }),
        (baseDamage, delta) => {
          const left = createTestWorld({ generatedEquipmentRunKey: 'snapshot-change' });
          const right = createTestWorld({ generatedEquipmentRunKey: 'snapshot-change' });

          const leftSnapshot = createGeneratedEquipmentInstance(left, inputFor({ baseDamage }))
            .frozen.activeWeaponSnapshot!;
          const rightSnapshot = createGeneratedEquipmentInstance(
            right,
            inputFor({ baseDamage: baseDamage + delta }),
          ).frozen.activeWeaponSnapshot!;

          expect(rightSnapshot.generatedEquipmentInstanceId).toBe(
            leftSnapshot.generatedEquipmentInstanceId,
          );
          expect(rightSnapshot.fingerprint).not.toBe(leftSnapshot.fingerprint);
        },
      ),
    );
  });
});
