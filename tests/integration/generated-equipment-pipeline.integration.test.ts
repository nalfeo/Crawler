import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
  getEquipmentState,
  getEffectiveStats,
} from '../../src/core/systems/equipmentSystem.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { getEntityEncumbranceSnapshot } from '../../src/core/encumbrance.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generated equipment real-pipeline integration', () => {
  it('preserves exact equipped identity, effective stats, and weight through a visual simulation step', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'b2-pipeline-test' });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    const input: GeneratedEquipmentCreateInputV1 = {
      baseId: 'armor.pipeline-helm',
      itemLevel: 4,
      rarity: 'common',
      enhancementLevel: 0,
      resolvedEffects: [],
      frozen: {
        schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
        displayName: 'Pipeline Helm',
        artKey: 'equipment.pipeline-helm',
        slots: ['head'],
        tags: ['armor'],
        weightLb: 18,
        statBonuses: { armor: 6 },
        abilityGrants: [],
        passiveGrants: [],
        activeWeaponSnapshot: null,
      },
    };
    const generated = createGeneratedEquipmentInstance(world, input);
    expect(addGeneratedEquipmentToBag(world, player, generated.instanceId).ok).toBe(true);
    expect(
      equipFromBag(
        world,
        player,
        { kind: 'generated-instance', instanceKey: generated.instanceId },
        { force: true },
      ).ok,
    ).toBe(true);

    runSimulationStep(world, createInputState());

    expect(getEquipmentState(world, player)!.equipped.head).toBe(generated.instanceId);
    expect(getEffectiveStats(world, player).armor).toBe(6);
    expect(getEntityEncumbranceSnapshot(world, player).equippedWeightLb).toBe(18);
  });
});
