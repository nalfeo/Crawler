import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
  type ActiveWeaponSnapshotV1,
  type FrozenEquipmentFieldsV1,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentGenerationPolicyV1,
  type GeneratedEquipmentInstanceId,
  type GeneratedEquipmentRarity,
  type ResolvedEquipmentEffectV1,
} from '../../src/shared/generated-equipment-types.js';
import { canonicalJson, sha256Hex } from '../../src/shared/canonical-json.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
  GeneratedEquipmentRegistryError,
  computeEquipmentFingerprint,
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
  getGeneratedEquipmentInstance,
  hasGeneratedEquipmentInstance,
  listGeneratedEquipmentInstances,
  registerGeneratedEquipmentInstance,
  requireGeneratedEquipmentActiveWeaponSnapshot,
  requireGeneratedEquipmentInstance,
  restoreGeneratedEquipmentRegistry,
  snapshotGeneratedEquipmentRegistry,
} from '../../src/core/generated-equipment-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

function weaponSnapshot(instanceId: GeneratedEquipmentInstanceId): ActiveWeaponSnapshotV1 {
  const def = getWeaponDef('sword');
  if (!def) throw new Error('Expected sword weapon definition');
  return createActiveWeaponSnapshotV1({ instanceId }, def);
}

function effectsFor(rarity: GeneratedEquipmentRarity): readonly ResolvedEquipmentEffectV1[] {
  if (rarity === 'common') return [];
  if (rarity === 'uncommon') {
    return [
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
    ];
  }
  return [
    {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'ember-step',
      effectOrdinal: 0,
      unitCost: 1,
      kind: 'abilityGrant',
      grantId: 'ember-step',
    },
    {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'warded',
      effectOrdinal: 1,
      unitCost: 1,
      kind: 'passiveGrant',
      grantId: 'warded',
    },
  ];
}

function frozenFields(
  activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null = null,
  abilityGrants: readonly string[] = [],
  passiveGrants: readonly string[] = [],
): FrozenEquipmentFieldsV1 {
  return {
    schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
    displayName: 'Ashen Sword',
    artKey: 'weapon.iron-cleaver',
    slots: ['mainHand'],
    tags: ['weapon', 'blade'],
    weightLb: 3,
    statBonuses: { strength: 1, critChance: 0.05 },
    abilityGrants,
    passiveGrants,
    activeWeaponSnapshot,
  };
}

function createInput(
  rarity: GeneratedEquipmentRarity = 'common',
  activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null = null,
): GeneratedEquipmentCreateInputV1 {
  const effects = effectsFor(rarity);
  const abilityGrants: string[] = [];
  const passiveGrants: string[] = [];
  for (const e of effects) {
    if ('grantId' in e) {
      if (e.kind === 'abilityGrant') abilityGrants.push(e.grantId);
      else if (e.kind === 'passiveGrant') passiveGrants.push(e.grantId);
    }
  }
  return {
    baseId: 'weapon.iron-cleaver',
    itemLevel: 3,
    rarity,
    enhancementLevel: 0,
    resolvedEffects: effects,
    frozen: frozenFields(activeWeaponSnapshot, abilityGrants, passiveGrants),
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

describe('canonical generated-equipment fingerprints', () => {
  it('matches standard SHA-256 vectors and Node crypto', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const unicode = 'Crawler equipment: 🗡️';
    expect(sha256Hex(unicode)).toBe(createHash('sha256').update(unicode).digest('hex'));
  });

  it('sorts object keys while retaining array order', () => {
    const first = { z: 1, nested: { b: true, a: 'x' }, values: [2, 1] };
    const second = { values: [2, 1], nested: { a: 'x', b: true }, z: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(computeEquipmentFingerprint(first)).toBe(computeEquipmentFingerprint(second));
    expect(canonicalJson({ values: [1, 2] })).not.toBe(canonicalJson({ values: [2, 1] }));
  });
});

describe('generated equipment instance registry', () => {
  it('fails closed until the world is configured with an explicit run key', () => {
    const world = createTestWorld();
    expectRegistryError(
      () => createGeneratedEquipmentInstance(world, createInput()),
      'registry-unconfigured',
    );
  });

  it('allocates stable keys, preserves static templates, and freezes the complete record', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'run-alpha' });
    const staticWeaponBefore = canonicalJson(getWeaponDef('sword'));

    const first = createGeneratedEquipmentInstance(
      world,
      createInput('common', weaponSnapshot(generatedEquipmentInstanceKey('run-alpha', 0))),
    );
    const second = createGeneratedEquipmentInstance(world, createInput('uncommon'));

    expect(first.instanceId).toBe('gei:v1:run-alpha:0');
    expect(second.instanceId).toBe('gei:v1:run-alpha:1');
    expect(generatedEquipmentInstanceKey('run-alpha', 1)).toBe(second.instanceId);
    expect(first.schemaVersion).toBe(GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.frozen)).toBe(true);
    expect(Object.isFrozen(first.frozen.statBonuses)).toBe(true);
    expect(Object.isFrozen(first.frozen.activeWeaponSnapshot)).toBe(true);
    expect(Object.isFrozen(first.resolvedEffects)).toBe(true);
    expect(first.frozen.activeWeaponSnapshot?.generatedEquipmentInstanceId).toBe(first.instanceId);
    expect(canonicalJson(getWeaponDef('sword'))).toBe(staticWeaponBefore);
  });

  it('supports deterministic lookup and rejects duplicates explicitly', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-lookup' });
    const instance = createGeneratedEquipmentInstance(source, createInput());
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-lookup' });

    const registered = registerGeneratedEquipmentInstance(target, instance);
    expect(hasGeneratedEquipmentInstance(target, instance.instanceId)).toBe(true);
    expect(getGeneratedEquipmentInstance(target, instance.instanceId)).toBe(registered);
    expect(requireGeneratedEquipmentInstance(target, instance.instanceId)).toBe(registered);
    expectRegistryError(
      () => registerGeneratedEquipmentInstance(target, instance),
      'duplicate-instance',
    );
    expectRegistryError(
      () => requireGeneratedEquipmentInstance(target, 'gei:v1:run-lookup:99'),
      'not-found',
    );
  });

  it('rejects ordinal gaps without mutating allocator state', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-gap' });
    createGeneratedEquipmentInstance(source, createInput());
    const second = createGeneratedEquipmentInstance(source, createInput());
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-gap' });

    expectRegistryError(() => registerGeneratedEquipmentInstance(target, second), 'ordinal-gap');
    const first = createGeneratedEquipmentInstance(target, createInput());
    expect(first.instanceId).toBe('gei:v1:run-gap:0');
  });

  it('rejects unknown versions, malformed frozen payloads, and content fingerprint drift', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-validation' });
    const instance = createGeneratedEquipmentInstance(source, createInput());

    const futureVersion = { ...instance, schemaVersion: 'floor2-equipment-instance/v2' };
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-validation' });
    expectRegistryError(
      () => registerGeneratedEquipmentInstance(target, futureVersion),
      'unsupported-version',
    );

    const tampered = {
      ...instance,
      frozen: { ...instance.frozen, displayName: 'Tampered Sword' },
    };
    expectRegistryError(
      () => registerGeneratedEquipmentInstance(target, tampered),
      'fingerprint-mismatch',
    );

    const invalidInput = {
      ...createInput(),
      frozen: { ...frozenFields(), weightLb: Number.NaN },
    };
    expectRegistryError(
      () => createGeneratedEquipmentInstance(target, invalidInput),
      'invalid-payload',
    );
    expect(createGeneratedEquipmentInstance(target, createInput()).instanceId).toBe(
      'gei:v1:run-validation:0',
    );
  });

  it('requires the frozen weapon snapshot to match the owning generated instance id', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'run-snapshot-id' });

    expectRegistryError(
      () =>
        createGeneratedEquipmentInstance(
          world,
          createInput(
            'common',
            weaponSnapshot(generatedEquipmentInstanceKey('run-snapshot-id', 99)),
          ),
        ),
      'invalid-payload',
    );
  });

  it('rejects otherwise valid instances generated under different tuning', () => {
    const changedPolicy: GeneratedEquipmentGenerationPolicyV1 = {
      ...DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
      rarityInherentScalars: {
        ...DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1.rarityInherentScalars,
      },
      rarityEffectUnits: {
        ...DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1.rarityEffectUnits,
      },
      enhancementPercentPerLevel: 0.06,
      drawOrder: [...DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1.drawOrder],
    };
    const source = createTestWorld({
      generatedEquipmentRunKey: 'run-tuning',
      generatedEquipmentGenerationPolicy: changedPolicy,
    });
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-tuning' });
    const instance = createGeneratedEquipmentInstance(source, createInput());

    expectRegistryError(() => registerGeneratedEquipmentInstance(target, instance), 'tuning-drift');
    expect(listGeneratedEquipmentInstances(target)).toEqual([]);
  });

  it('rejects instances and snapshots from a different run key without mutation', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-source' });
    const instance = createGeneratedEquipmentInstance(source, createInput());
    const snapshot = snapshotGeneratedEquipmentRegistry(source);
    const registrationTarget = createTestWorld({ generatedEquipmentRunKey: 'run-target' });
    const restoreTarget = createTestWorld({ generatedEquipmentRunKey: 'run-target' });

    expectRegistryError(
      () => registerGeneratedEquipmentInstance(registrationTarget, instance),
      'run-key-mismatch',
    );
    expectRegistryError(
      () => restoreGeneratedEquipmentRegistry(restoreTarget, snapshot),
      'run-key-mismatch',
    );
    expect(listGeneratedEquipmentInstances(registrationTarget)).toEqual([]);
    expect(listGeneratedEquipmentInstances(restoreTarget)).toEqual([]);
  });

  it('round-trips a plain ordered registry snapshot and resumes allocation', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-save' });
    const first = createGeneratedEquipmentInstance(source, createInput('common'));
    const second = createGeneratedEquipmentInstance(source, createInput('rare'));
    const serialized = JSON.parse(JSON.stringify(snapshotGeneratedEquipmentRegistry(source)));
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-save' });

    restoreGeneratedEquipmentRegistry(target, serialized);

    expect(listGeneratedEquipmentInstances(target).map((item) => item.instanceId)).toEqual([
      first.instanceId,
      second.instanceId,
    ]);
    expect(snapshotGeneratedEquipmentRegistry(target)).toEqual(
      snapshotGeneratedEquipmentRegistry(source),
    );
    expect(createGeneratedEquipmentInstance(target, createInput()).instanceId).toBe(
      'gei:v1:run-save:2',
    );
    expectRegistryError(
      () => restoreGeneratedEquipmentRegistry(target, serialized),
      'registry-not-empty',
    );
  });

  it('rejects a snapshot whose next ordinal does not match its instance count', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-next-ordinal' });
    createGeneratedEquipmentInstance(source, createInput());
    createGeneratedEquipmentInstance(source, createInput());
    const snapshot = snapshotGeneratedEquipmentRegistry(source);
    const malformed = { ...snapshot, nextOrdinal: 5 };
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-next-ordinal' });

    expectRegistryError(() => restoreGeneratedEquipmentRegistry(target, malformed), 'ordinal-gap');
    expect(listGeneratedEquipmentInstances(target)).toEqual([]);
    expect(createGeneratedEquipmentInstance(target, createInput()).instanceId).toBe(
      'gei:v1:run-next-ordinal:0',
    );
  });

  it('restores atomically when a later snapshot record is invalid', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-atomic-restore' });
    createGeneratedEquipmentInstance(source, createInput());
    createGeneratedEquipmentInstance(source, createInput());
    const snapshot = snapshotGeneratedEquipmentRegistry(source);
    const malformed = {
      ...snapshot,
      instances: [
        snapshot.instances[0],
        {
          ...snapshot.instances[1],
          fingerprint: `sha256:${'0'.repeat(64)}`,
        },
      ],
    };
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-atomic-restore' });

    expectRegistryError(
      () => restoreGeneratedEquipmentRegistry(target, malformed),
      'fingerprint-mismatch',
    );
    expect(listGeneratedEquipmentInstances(target)).toEqual([]);
    expect(createGeneratedEquipmentInstance(target, createInput()).instanceId).toBe(
      'gei:v1:run-atomic-restore:0',
    );
  });

  it('looks up a generated active-weapon snapshot through the registry seam', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'run-active-snapshot' });
    const instance = createGeneratedEquipmentInstance(
      world,
      createInput(
        'common',
        weaponSnapshot(generatedEquipmentInstanceKey('run-active-snapshot', 0)),
      ),
    );

    expect(requireGeneratedEquipmentActiveWeaponSnapshot(world, instance.instanceId)).toEqual(
      instance.frozen.activeWeaponSnapshot,
    );
  });
});
