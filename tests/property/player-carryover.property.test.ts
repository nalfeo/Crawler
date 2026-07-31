import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  createGeneratedEquipmentInstance,
  snapshotGeneratedEquipmentRegistry,
} from '../../src/core/generated-equipment-registry.js';
import { addGeneratedEquipmentToBag } from '../../src/core/systems/equipmentSystem.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { listGeneratedEquipmentReferences } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { generatedEquipmentInput } from '../fixtures/generated-equipment.js';

describe('player carryover properties', () => {
  it('preserves registry order and exact bag keys through JSON for generated item counts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (count) => {
        const runKey = 'carryover-property-run';
        const source = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
        const sourcePlayer = spawnPlayer(source, 0, 0);
        const expectedKeys: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const instance = createGeneratedEquipmentInstance(
            source,
            generatedEquipmentInput({ baseId: `armor.property-${index}` }),
          );
          expectedKeys.push(instance.instanceId);
          expect(addGeneratedEquipmentToBag(source, sourcePlayer, instance.instanceId).ok).toBe(
            true,
          );
        }

        const serialized = JSON.parse(
          JSON.stringify(capturePlayerCarryover(source, sourcePlayer)),
        ) as unknown;
        const destination = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
        const destinationPlayer = spawnPlayer(destination, 0, 0);
        restorePlayerCarryover(destination, destinationPlayer, serialized);

        const destinationBag = destination.inventories.get(destinationPlayer);
        expect(
          destinationBag
            ? listGeneratedEquipmentReferences(destinationBag).map((entry) => entry.instanceKey)
            : undefined,
        ).toEqual(expectedKeys);
        expect(snapshotGeneratedEquipmentRegistry(destination)).toEqual(
          snapshotGeneratedEquipmentRegistry(source),
        );
      }),
      { numRuns: 30 },
    );
  });
});
