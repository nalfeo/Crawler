import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
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
import {
  DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
  GeneratedEquipmentRegistryError,
  computeEquipmentFingerprint,
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  createGeneratedEquipmentRegistryTransaction,
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
  it('rejects instance ordinals that cannot be represented safely', () => {
    expectRegistryError(
      () => generatedEquipmentInstanceKey('run-alpha', Number.MAX_SAFE_INTEGER + 1),
      'invalid-payload',
    );
  });

  it('fails closed until the world is configured with an explicit run key', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: null });
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

  it('restores a sparse snapshot with a surviving ordinal gap in ascending order', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-sparse-gap' });
    const first = createGeneratedEquipmentInstance(source, createInput());
    createGeneratedEquipmentInstance(source, createInput('rare'));
    const third = createGeneratedEquipmentInstance(source, createInput('uncommon'));
    const snapshot = snapshotGeneratedEquipmentRegistry(source);
    // Retirement filtering drops the middle instance but preserves order.
    const sparse = {
      ...snapshot,
      instances: [snapshot.instances[0], snapshot.instances[2]],
    };
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-sparse-gap' });

    restoreGeneratedEquipmentRegistry(target, sparse, { allowSparseOrdinals: true });

    expect(listGeneratedEquipmentInstances(target).map((item) => item.instanceId)).toEqual([
      first.instanceId,
      third.instanceId,
    ]);
  });

  it('rejects a sparse snapshot whose ordinals are reordered rather than merely gapped', () => {
    const source = createTestWorld({ generatedEquipmentRunKey: 'run-sparse-reorder' });
    createGeneratedEquipmentInstance(source, createInput());
    createGeneratedEquipmentInstance(source, createInput('rare'));
    createGeneratedEquipmentInstance(source, createInput('uncommon'));
    const snapshot = snapshotGeneratedEquipmentRegistry(source);
    const reordered = {
      ...snapshot,
      instances: [snapshot.instances[2], snapshot.instances[0]],
    };
    const target = createTestWorld({ generatedEquipmentRunKey: 'run-sparse-reorder' });

    expectRegistryError(
      () => restoreGeneratedEquipmentRegistry(target, reordered, { allowSparseOrdinals: true }),
      'ordinal-gap',
    );
    expect(listGeneratedEquipmentInstances(target)).toEqual([]);
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

  it('rejects frozen/resolvedEffects grant mismatches and does not advance the allocator', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'run-grant-mismatch' });

    const grantEffect: ResolvedEquipmentEffectV1 = {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'ember-step',
      effectOrdinal: 0,
      unitCost: 1,
      kind: 'abilityGrant',
      grantId: 'ember-step',
    };
    const passiveEffect: ResolvedEquipmentEffectV1 = {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'warded',
      effectOrdinal: 0,
      unitCost: 1,
      kind: 'passiveGrant',
      grantId: 'warded',
    };

    // resolvedEffects advertises an active grant that frozen.abilityGrants omits.
    expectRegistryError(
      () =>
        createGeneratedEquipmentInstance(world, {
          ...createInput('common'),
          resolvedEffects: [grantEffect],
        }),
      'invalid-payload',
    );

    // frozen.abilityGrants advertises an ability that no resolvedEffect applies.
    expectRegistryError(
      () =>
        createGeneratedEquipmentInstance(world, {
          ...createInput('common'),
          frozen: { ...frozenFields(), abilityGrants: ['ember-step'] },
        }),
      'invalid-payload',
    );

    // resolvedEffects advertises a passive grant that frozen.passiveGrants omits.
    // Use uncommon rarity so the 1-unit effect passes the budget check and the
    // validation reaches validateGrantEquivalence rather than the unit-budget gate.
    const passiveMismatch = expectRegistryError(
      () =>
        createGeneratedEquipmentInstance(world, {
          ...createInput('uncommon'),
          resolvedEffects: [passiveEffect],
        }),
      'invalid-payload',
    );
    expect(passiveMismatch.path).toBe('$.instance.frozen.passiveGrants');

    // Order matters: if frozen has two passive grants in reversed order it is rejected.
    const passiveEffect2: ResolvedEquipmentEffectV1 = {
      schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      effectId: 'sturdy',
      effectOrdinal: 1,
      unitCost: 1,
      kind: 'passiveGrant',
      grantId: 'sturdy',
    };
    // Use rare rarity so the 2-unit total passes the budget check and the
    // validation reaches validateGrantEquivalence for the ordering assertion.
    const passiveOrder = expectRegistryError(
      () =>
        createGeneratedEquipmentInstance(world, {
          ...createInput('rare'),
          resolvedEffects: [passiveEffect, passiveEffect2],
          // frozen lists the two passive grants in reverse order — rejected.
          frozen: { ...frozenFields(), passiveGrants: ['sturdy', 'warded'] },
        }),
      'invalid-payload',
    );
    expect(passiveOrder.path).toBe('$.instance.frozen.passiveGrants');

    // After all failed attempts the allocator must not have advanced.
    expect(createGeneratedEquipmentInstance(world, createInput()).instanceId).toBe(
      'gei:v1:run-grant-mismatch:0',
    );
  });
});

describe('generated equipment registry transaction atomicity', () => {
  it('scratch mutations are invisible on the live registry before commit', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'txn-invisible' });
    const txn = createGeneratedEquipmentRegistryTransaction(world);

    // Generate one instance into the scratch registry.
    const scratch = { ...world, generatedEquipmentRegistry: txn.registry };
    const instance = createGeneratedEquipmentInstance(scratch, createInput('common'));

    // The live registry must NOT see this instance yet.
    expect(hasGeneratedEquipmentInstance(world, instance.instanceId)).toBe(false);
    expect(listGeneratedEquipmentInstances(world)).toHaveLength(0);
  });

  it('a discarded (uncommitted) transaction leaves live instances and ordinals unchanged', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'txn-discard' });
    // One pre-existing live instance establishes the baseline.
    const priorInstance = createGeneratedEquipmentInstance(world, createInput('uncommon'));
    const liveCountBefore = listGeneratedEquipmentInstances(world).length;

    const txn = createGeneratedEquipmentRegistryTransaction(world);
    const scratch = { ...world, generatedEquipmentRegistry: txn.registry };
    createGeneratedEquipmentInstance(scratch, createInput('rare'));
    // Never call txn.commit() — just discard the transaction.

    // Live registry must be exactly as it was.
    expect(listGeneratedEquipmentInstances(world)).toHaveLength(liveCountBefore);
    expect(listGeneratedEquipmentInstances(world)[0]!.instanceId).toBe(priorInstance.instanceId);

    // The next live-registry allocation must continue from the pre-txn ordinal
    // (ordinal 1, since ordinal 0 is the prior instance).
    const nextLive = createGeneratedEquipmentInstance(world, createInput('common'));
    expect(nextLive.instanceId).toBe('gei:v1:txn-discard:1');
  });

  it('commit publishes scratch state: instances become visible on live registry', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'txn-commit' });
    const txn = createGeneratedEquipmentRegistryTransaction(world);
    const scratch = { ...world, generatedEquipmentRegistry: txn.registry };
    const instance = createGeneratedEquipmentInstance(scratch, createInput('rare'));

    // Before commit: invisible on live.
    expect(hasGeneratedEquipmentInstance(world, instance.instanceId)).toBe(false);

    txn.commit();

    // After commit: visible on live.
    expect(hasGeneratedEquipmentInstance(world, instance.instanceId)).toBe(true);
    expect(getGeneratedEquipmentInstance(world, instance.instanceId)).toEqual(instance);
    expect(listGeneratedEquipmentInstances(world)).toHaveLength(1);
  });

  it('a second commit is rejected with invalid-payload and leaves live state unchanged', () => {
    const world = createTestWorld({ generatedEquipmentRunKey: 'txn-double-commit' });
    const txn = createGeneratedEquipmentRegistryTransaction(world);
    const scratch = { ...world, generatedEquipmentRegistry: txn.registry };
    createGeneratedEquipmentInstance(scratch, createInput('common'));

    txn.commit();
    const countAfterFirstCommit = listGeneratedEquipmentInstances(world).length;

    // The second commit must throw.
    expectRegistryError(() => txn.commit(), 'invalid-payload');

    // Live state must be unmodified by the failed second commit.
    expect(listGeneratedEquipmentInstances(world)).toHaveLength(countAfterFirstCommit);
  });
});
