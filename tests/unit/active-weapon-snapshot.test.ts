import { describe, expect, it } from 'vitest';
import {
  getActiveWeaponGeneration,
  getActiveWeaponSnapshot,
  setActiveWeaponDef,
} from '../../src/core/active-weapon.js';
import {
  GeneratedEquipmentRegistryError,
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
  validateActiveWeaponSnapshotV1,
} from '../../src/core/generated-equipment-registry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type ActiveWeaponSnapshotV1,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createInput(snapshot: ActiveWeaponSnapshotV1): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: 'weapon.fireball-test',
    itemLevel: 4,
    rarity: 'uncommon',
    enhancementLevel: 0,
    resolvedEffects: [
      {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: 'sturdy',
        effectOrdinal: 0,
        unitCost: 1,
        kind: 'stat',
        stat: 'armor',
        operation: 'add',
        value: 2,
      },
    ],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Ashen Fireball',
      artKey: 'weapon.fireball-test',
      slots: ['mainHand'],
      tags: ['weapon', 'magic'],
      weightLb: 2,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: snapshot,
    },
  };
}

function expectRegistryError(action: () => unknown, code: string): GeneratedEquipmentRegistryError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GeneratedEquipmentRegistryError);
    expect((error as GeneratedEquipmentRegistryError).code).toBe(code);
    return error as GeneratedEquipmentRegistryError;
  }
  throw new Error(`Expected GeneratedEquipmentRegistryError(${code})`);
}

describe('active weapon snapshots', () => {
  it('creates deterministic per-instance snapshots without mutating the base weapon def', () => {
    const fireball = getWeaponDef('fireball');
    if (!fireball) throw new Error('Expected fireball weapon definition');

    const before = structuredClone(fireball);
    const instanceId = generatedEquipmentInstanceKey('run-snapshot', 0);
    const first = createActiveWeaponSnapshotV1({ instanceId }, fireball, {
      name: 'Ashen Fireball',
      baseDamage: fireball.baseDamage + 7,
      cooldownMs: 333,
    });
    const second = createActiveWeaponSnapshotV1({ instanceId }, fireball, {
      name: 'Ashen Fireball',
      baseDamage: fireball.baseDamage + 7,
      cooldownMs: 333,
    });

    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.generatedEquipmentInstanceId).toBe(instanceId);
    expect(first.id).toBe(fireball.id);
    expect(first.sourceWeaponDefId).toBe(fireball.id);
    expect(first.canonicalSkillTags).toEqual([
      `weapon-class:${first.weaponClassSkillId}`,
      `weapon-type:${first.weaponTypeSkillId}`,
    ]);
    expect(getWeaponDef('fireball')).toEqual(before);
    expect(getWeaponDef('fireball')).toBe(fireball);
  });

  it('rejects illegal overrides, unsupported versions, and stale fingerprints explicitly', () => {
    const fireball = getWeaponDef('fireball');
    if (!fireball) throw new Error('Expected fireball weapon definition');
    const snapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-errors', 0) },
      fireball,
      { baseDamage: fireball.baseDamage + 5 },
    );

    expectRegistryError(
      () =>
        createActiveWeaponSnapshotV1(
          { instanceId: snapshot.generatedEquipmentInstanceId },
          fireball,
          { id: 'hack' },
        ),
      'illegal-override',
    );
    expectRegistryError(
      () =>
        validateActiveWeaponSnapshotV1({ ...snapshot, schemaVersion: 'active-weapon-snapshot/v2' }),
      'unsupported-version',
    );
    expectRegistryError(
      () => validateActiveWeaponSnapshotV1({ ...snapshot, baseDamage: snapshot.baseDamage + 1 }),
      'fingerprint-mismatch',
    );
  });

  it('rejects missing registry identities and stores the authoritative registered snapshot', () => {
    const fireball = getWeaponDef('fireball');
    if (!fireball) throw new Error('Expected fireball weapon definition');

    const missingWorld = createTestWorld({ generatedEquipmentRunKey: 'run-authority' });
    const missingSnapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-authority', 0) },
      fireball,
      { baseDamage: fireball.baseDamage + 2 },
    );
    expectRegistryError(() => setActiveWeaponDef(missingWorld, missingSnapshot), 'not-found');

    const world = createTestWorld({ generatedEquipmentRunKey: 'run-authority' });
    const firstSnapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-authority', 0) },
      fireball,
      { baseDamage: fireball.baseDamage + 2 },
    );
    const secondSnapshot = createActiveWeaponSnapshotV1(
      { instanceId: generatedEquipmentInstanceKey('run-authority', 1) },
      fireball,
      { baseDamage: fireball.baseDamage + 9 },
    );
    createGeneratedEquipmentInstance(world, createInput(firstSnapshot));
    createGeneratedEquipmentInstance(world, createInput(secondSnapshot));

    setActiveWeaponDef(world, firstSnapshot);
    const firstGeneration = getActiveWeaponGeneration(world);
    expect(getActiveWeaponSnapshot(world)?.fingerprint).toBe(firstSnapshot.fingerprint);

    setActiveWeaponDef(world, secondSnapshot);
    expect(getActiveWeaponGeneration(world)).toBeGreaterThan(firstGeneration);
    expect(getActiveWeaponSnapshot(world)?.fingerprint).toBe(secondSnapshot.fingerprint);
  });
});
