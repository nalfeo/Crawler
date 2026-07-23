import { describe, expect, it } from 'vitest';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import { evaluateEquipmentLoadoutCandidates } from '../../src/game/ai/equipment-loadout-evaluator.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment to loadout evaluator integration', () => {
  it('consumes the registered immutable instance and weapon snapshot without changing the world', () => {
    const world = createTestWorld({
      seed: 42,
      generatedEquipmentRunKey: 'erv-runtime-integration',
    });
    const generated = generateEquipmentInstance(world, {
      baseId: 'plasma-pistol',
      itemLevel: 3,
      rarity: 'rare',
      enhancementLevel: 2,
    });
    const registeredBefore = listGeneratedEquipmentInstances(world);

    const result = evaluateEquipmentLoadoutCandidates({
      current: {
        equipped: [],
        baseStats: {
          strength: 10,
          dexterity: 10,
          intelligence: 10,
          moveSpeed: 1,
          critMultiplier: 1.5,
          maxHp: 100,
        },
        coreStatPoints: {},
        activeAbilityGrantSources: new Map(),
        passiveAbilityGrantSources: new Map(),
        equippedActiveAbilityIds: [],
        bodyWeightLb: 180,
      },
      candidates: [{ instance: generated, source: 'inventory', purchaseCost: 0 }],
      remainingEncounters: [
        {
          id: 'integration-fixture',
          durationSeconds: 30,
          enemyCount: 6,
          clusteredEnemyCount: 3,
          incomingHitDamage: 5,
          incomingHitsPerSecond: 0.25,
          lowHealthUptime: 0,
          skillTriggerRatePerSecond: 1,
        },
      ],
      affinityTagWeights: { weapon: 2, physical: 3 },
    });

    expect(result.rejected).toEqual([]);
    expect(result.ranked[0]?.nextScore.activeWeaponInstanceId).toBe(generated.instanceId);
    expect(result.ranked[0]?.nextScore.components.offense).toBeGreaterThan(0);
    expect(result.ranked[0]?.nextScore.components.affinity).toBe(5);
    expect(listGeneratedEquipmentInstances(world)).toEqual(registeredBefore);
    expect(Object.isFrozen(generated.frozen.activeWeaponSnapshot)).toBe(true);
  });
});
