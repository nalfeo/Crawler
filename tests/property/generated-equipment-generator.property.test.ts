import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import type {
  GeneratedEquipmentEnhancementLevel,
  GeneratedEquipmentRarity,
} from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const rarityArbitrary = fc.constantFrom<GeneratedEquipmentRarity>('common', 'uncommon', 'rare');
const enhancementArbitrary = fc
  .integer({ min: 0, max: 5 })
  .map((value) => value as GeneratedEquipmentEnhancementLevel);

describe('generated equipment properties', () => {
  it('produces identical frozen instances and fingerprints from identical seeded inputs', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 1, max: 50 }),
        rarityArbitrary,
        enhancementArbitrary,
        fc.constantFrom('plasma-pistol', 'iron-breastplate', 'band-of-fortune'),
        (seed, itemLevel, rarity, enhancementLevel, baseId) => {
          const left = createTestWorld({
            seed,
            generatedEquipmentRunKey: 'generator-property',
          });
          const right = createTestWorld({
            seed,
            generatedEquipmentRunKey: 'generator-property',
          });
          const request = {
            baseId,
            itemLevel,
            rarity,
            enhancementLevel: baseId === 'band-of-fortune' ? 0 : enhancementLevel,
          } as const;

          const leftInstance = generateEquipmentInstance(left, request);
          const rightInstance = generateEquipmentInstance(right, request);

          expect(rightInstance).toEqual(leftInstance);
          expect(rightInstance.fingerprint).toBe(leftInstance.fingerprint);
          expect(Object.isFrozen(leftInstance)).toBe(true);
          expect(Object.isFrozen(leftInstance.frozen)).toBe(true);
          expect(Object.isFrozen(leftInstance.resolvedEffects)).toBe(true);
        },
      ),
    );
  });

  it('always spends the exact rarity budget with unique legal effects', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        rarityArbitrary,
        fc.constantFrom('plasma-pistol', 'iron-breastplate', 'band-of-fortune'),
        (seed, rarity, baseId) => {
          const world = createTestWorld({
            seed,
            generatedEquipmentRunKey: 'generator-budget',
          });
          const instance = generateEquipmentInstance(world, {
            baseId,
            itemLevel: 7,
            rarity,
            enhancementLevel: 0,
          });
          const requiredUnits =
            world.generatedEquipmentRegistry.generationPolicy.rarityEffectUnits[rarity];
          const effectIds = instance.resolvedEffects.map((effect) => effect.effectId);

          expect(
            instance.resolvedEffects.reduce(
              (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
              0,
            ),
          ).toBe(requiredUnits);
          expect(new Set(effectIds).size).toBe(effectIds.length);
          expect(effectIds.includes('vital') && effectIds.includes('fortunate')).toBe(false);
          expect(
            instance.resolvedEffects.map((effect) =>
              'effectOrdinal' in effect ? effect.effectOrdinal : -1,
            ),
          ).toEqual(instance.resolvedEffects.map((_, index) => index));
          expect(instance.frozen.abilityGrants).toEqual(
            instance.resolvedEffects.flatMap((effect) =>
              'kind' in effect && effect.kind === 'abilityGrant' ? [effect.grantId] : [],
            ),
          );
          expect(instance.frozen.passiveGrants).toEqual(
            instance.resolvedEffects.flatMap((effect) =>
              'kind' in effect && effect.kind === 'passiveGrant' ? [effect.grantId] : [],
            ),
          );
        },
      ),
    );
  });
});
