import { describe, expect, it } from 'vitest';
import {
  clearActiveWeaponDef,
  getActiveWeaponDef,
  getActiveWeaponGeneration,
  getActiveWeaponSnapshot,
  setActiveWeaponDef,
  setActiveWeaponFromGeneratedInstance,
} from '../../src/core/active-weapon.js';
import {
  GeneratedEquipmentRegistryError,
  computeActiveWeaponSnapshotFingerprint,
  createActiveWeaponSnapshotInput,
  createGeneratedEquipmentInstance,
  validateActiveWeaponSnapshotV1,
} from '../../src/core/generated-equipment-registry.js';
import { canonicalJson } from '../../src/shared/canonical-json.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  type ActiveWeaponCombatOverridesV1,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';

function weaponInput(
  baseWeaponId = 'pistol',
  overrides: ActiveWeaponCombatOverridesV1 = {},
): GeneratedEquipmentCreateInputV1 {
  return {
    baseId: `weapon.generated-${baseWeaponId}`,
    itemLevel: 3,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: `Generated ${baseWeaponId}`,
      artKey: `weapon.generated-${baseWeaponId}`,
      slots: ['mainHand'],
      tags: ['weapon'],
      weightLb: 3,
      statBonuses: {},
      abilityGrants: [],
      passiveGrants: [],
      activeWeaponSnapshot: createActiveWeaponSnapshotInput(baseWeaponId, overrides),
    },
  };
}

function expectRegistryError(
  action: () => unknown,
  code: GeneratedEquipmentRegistryError['code'],
): void {
  expect(action).toThrowError(
    expect.objectContaining<Partial<GeneratedEquipmentRegistryError>>({
      name: 'GeneratedEquipmentRegistryError',
      code,
    }),
  );
}

describe('ActiveWeaponSnapshotV1', () => {
  it('finalizes generated identity without mutating the static WeaponDef', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-finalize' });
    const staticDef = getWeaponDef('pistol')!;
    const staticBefore = canonicalJson(staticDef);

    const instance = createGeneratedEquipmentInstance(
      world,
      weaponInput('pistol', { baseDamage: 41, cooldownMs: 275 }),
    );
    const snapshot = instance.frozen.activeWeaponSnapshot!;

    expect(snapshot.generatedEquipmentInstanceId).toBe(instance.instanceId);
    expect(snapshot.baseWeaponId).toBe(staticDef.id);
    expect(snapshot.baseDamage).toBe(41);
    expect(snapshot.cooldownMs).toBe(275);
    expect(snapshot.weaponClassSkillId).toBe(staticDef.weaponClassSkillId);
    expect(snapshot.weaponTypeSkillId).toBe(staticDef.weaponTypeSkillId);
    expect(snapshot.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(getWeaponDef('pistol')).toBe(staticDef);
    expect(canonicalJson(staticDef)).toBe(staticBefore);
  });

  it('keeps same-base generated copies distinct and switches by instance fingerprint', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-copies' });
    const first = createGeneratedEquipmentInstance(
      world,
      weaponInput('pistol', { baseDamage: 10 }),
    );
    const second = createGeneratedEquipmentInstance(
      world,
      weaponInput('pistol', { baseDamage: 20 }),
    );

    const firstSnapshot = first.frozen.activeWeaponSnapshot!;
    const secondSnapshot = second.frozen.activeWeaponSnapshot!;
    expect(firstSnapshot.baseWeaponId).toBe(secondSnapshot.baseWeaponId);
    expect(firstSnapshot.generatedEquipmentInstanceId).not.toBe(
      secondSnapshot.generatedEquipmentInstanceId,
    );
    expect(firstSnapshot.fingerprint).not.toBe(secondSnapshot.fingerprint);

    expect(setActiveWeaponFromGeneratedInstance(world, first.instanceId)).toBe(true);
    const firstGeneration = getActiveWeaponGeneration(world);
    expect(setActiveWeaponFromGeneratedInstance(world, second.instanceId)).toBe(true);
    expect(getActiveWeaponGeneration(world)).toBe(firstGeneration + 1);
    expect(getActiveWeaponDef(world)?.id).toBe('pistol');
    expect(getActiveWeaponSnapshot(world)).toEqual(secondSnapshot);
    expect(setActiveWeaponFromGeneratedInstance(world, second.instanceId)).toBe(false);
    expect(getActiveWeaponGeneration(world)).toBe(firstGeneration + 1);
  });

  it('preserves static active-weapon identity and live-tuning behavior', () => {
    const world = createTestWorld();
    const pistol = getWeaponDef('pistol')!;
    const tuned = Object.freeze({ ...pistol, baseDamage: pistol.baseDamage + 1 });

    expect(setActiveWeaponDef(world, pistol)).toBe(true);
    const generation = getActiveWeaponGeneration(world);
    expect(setActiveWeaponDef(world, tuned)).toBe(false);
    expect(getActiveWeaponGeneration(world)).toBe(generation);
    expect(getActiveWeaponDef(world)).toBe(tuned);
    expect(getActiveWeaponSnapshot(world)).toBeUndefined();
    clearActiveWeaponDef(world);
    expect(getActiveWeaponGeneration(world)).toBe(generation + 1);
  });

  it('fails explicitly for missing identities, unsupported versions, illegal overrides, and drift', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-errors' });
    const instance = createGeneratedEquipmentInstance(world, weaponInput());
    const snapshot = instance.frozen.activeWeaponSnapshot!;
    const { generatedEquipmentInstanceId: _missingIdentity, ...withoutIdentity } = snapshot;

    expectRegistryError(() => validateActiveWeaponSnapshotV1(withoutIdentity), 'invalid-payload');
    expectRegistryError(
      () =>
        validateActiveWeaponSnapshotV1({
          ...snapshot,
          schemaVersion: 'active-weapon-snapshot/v2',
        }),
      'unsupported-version',
    );
    expectRegistryError(
      () =>
        createActiveWeaponSnapshotInput('pistol', {
          weaponType: 0,
        } as unknown as ActiveWeaponCombatOverridesV1),
      'illegal-override',
    );
    expectRegistryError(
      () =>
        validateActiveWeaponSnapshotV1({
          ...snapshot,
          weaponClassSkillId: 'arcane',
        }),
      'illegal-override',
    );
    expectRegistryError(
      () =>
        validateActiveWeaponSnapshotV1({
          ...snapshot,
          baseDamage: snapshot.baseDamage + 1,
        }),
      'fingerprint-mismatch',
    );
    expectRegistryError(
      () => setActiveWeaponFromGeneratedInstance(world, 'gei:v1:snapshot-errors:99'),
      'not-found',
    );
  });

  it('hashes every immutable snapshot field except the fingerprint itself', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-coverage' });
    const snapshot = createGeneratedEquipmentInstance(world, weaponInput()).frozen
      .activeWeaponSnapshot!;
    const { fingerprint: _fingerprint, ...content } = snapshot;
    const baseline = computeActiveWeaponSnapshotFingerprint(content);

    for (const key of Object.keys(content) as (keyof typeof content)[]) {
      const value = content[key];
      const changed = typeof value === 'number' ? value + 1 : `${String(value)}-changed`;
      const mutated = { ...content, [key]: changed } as typeof content;
      expect(
        computeActiveWeaponSnapshotFingerprint(mutated),
        `expected ${key} to affect the fingerprint`,
      ).not.toBe(baseline);
    }
  });

  it('rejects activation of a generated non-weapon instance', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'snapshot-non-weapon' });
    const input = weaponInput();
    const instance = createGeneratedEquipmentInstance(world, {
      ...input,
      frozen: { ...input.frozen, activeWeaponSnapshot: null },
    });

    expectRegistryError(
      () => setActiveWeaponFromGeneratedInstance(world, instance.instanceId),
      'invalid-payload',
    );
  });
});
