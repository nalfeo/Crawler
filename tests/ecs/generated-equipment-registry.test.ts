/**
 * Unit tests for the generated equipment registry (B1).
 *
 * Covers: identity, lookup, version rejection, duplicate handling,
 * structural validation rejection, fingerprint validation, tuning drift,
 * per-world isolation, feature flag gating, snapshot/hydrate round-trip.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import {
  createInstanceId,
  registerInstance,
  lookupInstance,
  hasInstance,
  getRegistrySize,
  computeFingerprint,
  validateFingerprint,
  canonicalJson,
  validateInstanceStructure,
  snapshotRegistry,
  hydrateRegistry,
} from '../../src/game/generated-equipment-registry.js';
import {
  isValidGeneratedInstanceId,
  isValidFingerprintV1,
  isKnownGeneratedSchemaVersion,
  makeRunKey,
  RARITY_EFFECT_BUDGET,
  ENHANCEMENT_MIN,
  ENHANCEMENT_MAX,
} from '../../src/shared/generated-equipment-types.js';
import type {
  GeneratedEquipmentInstanceV1,
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentRarity,
  EquipmentFingerprintV1,
  FrozenEquipmentFieldsV1,
  ResolvedEquipmentEffectV1,
} from '../../src/shared/generated-equipment-types.js';
import type { StatId } from '../../src/shared/stats.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SCHEMA_V1 = 'floor2-equipment-instance/v1' as const;

/** Build a minimal valid frozen fields object. */
function makeFrozen(overrides?: Partial<FrozenEquipmentFieldsV1>): FrozenEquipmentFieldsV1 {
  return {
    displayName: 'Iron Visor',
    artKey: 'head.iron-visor',
    statBonuses: { armor: 3 },
    ...overrides,
  };
}

/** Build a minimal valid instance (without fingerprint). */
function makeInstanceBase(
  overrides: Partial<Omit<GeneratedEquipmentInstanceV1, 'fingerprint'>> = {},
): Omit<GeneratedEquipmentInstanceV1, 'fingerprint'> {
  return {
    schemaVersion: SCHEMA_V1,
    instanceId: createInstanceId('seed42', 1),
    contentRevision: 0,
    baseId: 'head.iron-visor',
    itemLevel: 1,
    rarity: 'common',
    enhancementLevel: 0,
    resolvedEffects: [],
    frozen: makeFrozen(),
    ...overrides,
  };
}

/** Build a valid uncommon instance (1 effect unit). */
function makeUncommonBase(
  overrides: Partial<Omit<GeneratedEquipmentInstanceV1, 'fingerprint'>> = {},
): Omit<GeneratedEquipmentInstanceV1, 'fingerprint'> {
  const effects: ResolvedEquipmentEffectV1[] = [
    { effectId: 'bonus-armor', magnitude: 5, units: 1 },
  ];
  return makeInstanceBase({ rarity: 'uncommon', resolvedEffects: effects, ...overrides });
}

/** Build a valid rare instance (2 effect units). */
function makeRareBase(
  overrides: Partial<Omit<GeneratedEquipmentInstanceV1, 'fingerprint'>> = {},
): Omit<GeneratedEquipmentInstanceV1, 'fingerprint'> {
  const effects: ResolvedEquipmentEffectV1[] = [
    { effectId: 'bonus-armor', magnitude: 5, units: 1 },
    { effectId: 'bonus-dodge', magnitude: 0.05, units: 1 },
  ];
  return makeInstanceBase({ rarity: 'rare', resolvedEffects: effects, ...overrides });
}

/** Create a fully valid registered instance in one async call. */
async function buildInstance(
  base: Omit<GeneratedEquipmentInstanceV1, 'fingerprint'> = makeInstanceBase(),
): Promise<GeneratedEquipmentInstanceV1> {
  const fp = await computeFingerprint(base);
  return { ...base, fingerprint: fp };
}

/** Enable registry flag on a world. */
function enableRegistry(world: GameWorld): GameWorld {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  return world;
}

// ---------------------------------------------------------------------------
// Identity tests
// ---------------------------------------------------------------------------

describe('createInstanceId', () => {
  it('produces the correct format', () => {
    const id = createInstanceId('seed42', 1);
    expect(id).toBe('gei:v1:seed42:1');
    expect(isValidGeneratedInstanceId(id)).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const a = createInstanceId('runABC', 7);
    const b = createInstanceId('runABC', 7);
    expect(a).toBe(b);
  });

  it('different ordinals produce different IDs', () => {
    const a = createInstanceId('runX', 1);
    const b = createInstanceId('runX', 2);
    expect(a).not.toBe(b);
  });

  it('different run keys produce different IDs', () => {
    const a = createInstanceId('runA', 1);
    const b = createInstanceId('runB', 1);
    expect(a).not.toBe(b);
  });

  it('supports zero ordinal', () => {
    const id = createInstanceId('run0', 0);
    expect(id).toBe('gei:v1:run0:0');
    expect(isValidGeneratedInstanceId(id)).toBe(true);
  });

  it('rejects run keys with colons', () => {
    expect(() => createInstanceId('run:key', 1)).toThrow();
  });

  it('rejects non-integer ordinals', () => {
    expect(() => createInstanceId('run', 1.5)).toThrow();
  });

  it('rejects negative ordinals', () => {
    expect(() => createInstanceId('run', -1)).toThrow();
  });

  it('allows hyphens and underscores in run key', () => {
    const id = createInstanceId('seed-42_v1', 0);
    expect(isValidGeneratedInstanceId(id)).toBe(true);
  });
});

describe('isValidGeneratedInstanceId', () => {
  it('returns true for valid IDs', () => {
    expect(isValidGeneratedInstanceId('gei:v1:abc:0')).toBe(true);
    expect(isValidGeneratedInstanceId('gei:v1:seed-42_x:99')).toBe(true);
  });

  it('returns false for invalid formats', () => {
    expect(isValidGeneratedInstanceId('gei:v1::0')).toBe(false); // empty run key
    expect(isValidGeneratedInstanceId('gei:v2:abc:0')).toBe(false); // wrong version
    expect(isValidGeneratedInstanceId('gei:v1:abc:-1')).toBe(false); // negative ordinal
    expect(isValidGeneratedInstanceId('abc:1')).toBe(false);
    expect(isValidGeneratedInstanceId('')).toBe(false);
  });
});

describe('isKnownGeneratedSchemaVersion', () => {
  it('returns true for the known schema', () => {
    expect(isKnownGeneratedSchemaVersion('floor2-equipment-instance/v1')).toBe(true);
  });

  it('returns false for unknown versions', () => {
    expect(isKnownGeneratedSchemaVersion('floor2-equipment-instance/v2')).toBe(false);
    expect(isKnownGeneratedSchemaVersion('')).toBe(false);
    expect(isKnownGeneratedSchemaVersion('floor1-equipment-instance/v1')).toBe(false);
  });
});

describe('makeRunKey', () => {
  it('sanitizes a numeric seed', () => {
    expect(makeRunKey(42)).toBe('42');
  });

  it('strips special characters', () => {
    expect(makeRunKey('seed:with:colons')).toBe('seedwithcolons');
  });

  it('throws for empty result', () => {
    expect(() => makeRunKey(':::')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fingerprint tests
// ---------------------------------------------------------------------------

describe('computeFingerprint', () => {
  it('produces a valid sha256: fingerprint', async () => {
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    expect(isValidFingerprintV1(fp)).toBe(true);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const base = makeInstanceBase();
    const fp1 = await computeFingerprint(base);
    const fp2 = await computeFingerprint(base);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different content', async () => {
    const base1 = makeInstanceBase({ baseId: 'head.iron-visor' });
    const base2 = makeInstanceBase({ baseId: 'head.quartermaster-cap' });
    const fp1 = await computeFingerprint(base1);
    const fp2 = await computeFingerprint(base2);
    expect(fp1).not.toBe(fp2);
  });

  it('is sensitive to rarity changes', async () => {
    const common = makeInstanceBase({ rarity: 'common' });
    const uncommon = makeUncommonBase();
    const fp1 = await computeFingerprint(common);
    const fp2 = await computeFingerprint(uncommon);
    expect(fp1).not.toBe(fp2);
  });

  it('is sensitive to enhancement level', async () => {
    const base0 = makeInstanceBase({ enhancementLevel: 0 });
    const base1 = makeInstanceBase({ enhancementLevel: 1 });
    const fp0 = await computeFingerprint(base0);
    const fp1 = await computeFingerprint(base1);
    expect(fp0).not.toBe(fp1);
  });

  it('is sensitive to frozen stat changes', async () => {
    const base1 = makeInstanceBase({ frozen: makeFrozen({ statBonuses: { armor: 3 } }) });
    const base2 = makeInstanceBase({ frozen: makeFrozen({ statBonuses: { armor: 4 } }) });
    const fp1 = await computeFingerprint(base1);
    const fp2 = await computeFingerprint(base2);
    expect(fp1).not.toBe(fp2);
  });
});

describe('validateFingerprint', () => {
  it('returns true for a correctly-built instance', async () => {
    const instance = await buildInstance();
    expect(await validateFingerprint(instance)).toBe(true);
  });

  it('returns false when fingerprint was computed for different content', async () => {
    const base1 = makeInstanceBase({ baseId: 'head.iron-visor' });
    const fp = await computeFingerprint(base1);
    // Use fingerprint from base1 but different content
    const base2 = makeInstanceBase({ baseId: 'head.quartermaster-cap' });
    const tampered: GeneratedEquipmentInstanceV1 = { ...base2, fingerprint: fp };
    expect(await validateFingerprint(tampered)).toBe(false);
  });

  it('detects tuning drift when statBonuses change', async () => {
    const base = makeInstanceBase({ frozen: makeFrozen({ statBonuses: { armor: 5 } }) });
    const fp = await computeFingerprint(base);
    // Simulate tuning drift: frozen stats changed but fingerprint not updated
    const drifted: GeneratedEquipmentInstanceV1 = {
      ...base,
      frozen: { ...base.frozen, statBonuses: { armor: 6 } },
      fingerprint: fp,
    };
    expect(await validateFingerprint(drifted)).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    const parsed = JSON.parse(result) as Record<string, number>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it('retains array order', () => {
    const arr = [3, 1, 2];
    const result = canonicalJson({ items: arr });
    expect(JSON.parse(result)).toEqual({ items: [3, 1, 2] });
  });

  it('throws on undefined values', () => {
    expect(() => canonicalJson({ key: undefined })).toThrow();
  });

  it('is stable regardless of insertion order', () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });
});

// ---------------------------------------------------------------------------
// Structural validation tests
// ---------------------------------------------------------------------------

describe('validateInstanceStructure', () => {
  it('returns null for a valid common instance', async () => {
    const instance = await buildInstance(makeInstanceBase());
    expect(validateInstanceStructure(instance)).toBeNull();
  });

  it('returns null for a valid uncommon instance', async () => {
    const instance = await buildInstance(makeUncommonBase());
    expect(validateInstanceStructure(instance)).toBeNull();
  });

  it('returns null for a valid rare instance', async () => {
    const instance = await buildInstance(makeRareBase());
    expect(validateInstanceStructure(instance)).toBeNull();
  });

  it('rejects unknown schemaVersion', async () => {
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    const bad = {
      ...base,
      schemaVersion: 'floor2-equipment-instance/v2' as unknown as typeof base.schemaVersion,
      fingerprint: fp,
    };
    expect(validateInstanceStructure(bad as GeneratedEquipmentInstanceV1)).not.toBeNull();
  });

  it('rejects invalid instanceId format', async () => {
    const base = makeInstanceBase({ instanceId: 'bad-id' as GeneratedEquipmentInstanceId });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects negative contentRevision', async () => {
    const base = makeInstanceBase({ contentRevision: -1 });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects empty baseId', async () => {
    const base = makeInstanceBase({ baseId: '' });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects non-positive itemLevel', async () => {
    const base = makeInstanceBase({ itemLevel: 0 });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects invalid rarity (e.g. epic)', async () => {
    const base = makeInstanceBase({ rarity: 'epic' as unknown as GeneratedEquipmentRarity });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects enhancementLevel > ENHANCEMENT_MAX', async () => {
    const base = makeInstanceBase({ enhancementLevel: 6 as unknown as 0 | 1 | 2 | 3 | 4 | 5 });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects effect unit budget mismatch (uncommon with 0 effects)', async () => {
    const base = makeInstanceBase({ rarity: 'uncommon', resolvedEffects: [] });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    const err = validateInstanceStructure(bad);
    expect(err).not.toBeNull();
    expect(err).toContain('budget');
  });

  it('rejects effect unit budget mismatch (rare with only 1 unit)', async () => {
    const base = makeRareBase({
      resolvedEffects: [{ effectId: 'bonus-armor', magnitude: 5, units: 1 }],
    });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    const err = validateInstanceStructure(bad);
    expect(err).not.toBeNull();
    expect(err).toContain('budget');
  });

  it('rejects duplicate effect IDs', async () => {
    const base = makeInstanceBase({
      rarity: 'rare',
      resolvedEffects: [
        { effectId: 'bonus-armor', magnitude: 5, units: 1 },
        { effectId: 'bonus-armor', magnitude: 3, units: 1 }, // duplicate
      ],
    });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects invalid StatId in statBonuses', async () => {
    const base = makeInstanceBase({
      frozen: makeFrozen({
        statBonuses: { not_a_real_stat: 5 } as unknown as Partial<Record<StatId, number>>,
      }),
    });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects non-finite statBonus value', async () => {
    const base = makeInstanceBase({
      frozen: makeFrozen({ statBonuses: { armor: Infinity } }),
    });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects malformed fingerprint format', async () => {
    const base = makeInstanceBase();
    const bad: GeneratedEquipmentInstanceV1 = {
      ...base,
      fingerprint: 'not-a-sha256' as unknown as EquipmentFingerprintV1,
    };
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects null frozen.statBonuses without throwing', async () => {
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = {
      ...base,
      fingerprint: fp,
      frozen: { ...base.frozen, statBonuses: null as unknown as Record<StatId, number> },
    };
    // Must return an error string, not throw a TypeError
    expect(() => validateInstanceStructure(bad)).not.toThrow();
    expect(validateInstanceStructure(bad)).not.toBeNull();
  });

  it('rejects null frozen without throwing', () => {
    const base = makeInstanceBase();
    const bad = {
      ...base,
      fingerprint: ('sha256:' + 'a'.repeat(64)) as unknown as EquipmentFingerprintV1,
      frozen: null as unknown as FrozenEquipmentFieldsV1,
    };
    expect(() => validateInstanceStructure(bad as GeneratedEquipmentInstanceV1)).not.toThrow();
    expect(validateInstanceStructure(bad as GeneratedEquipmentInstanceV1)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerInstance tests
// ---------------------------------------------------------------------------

describe('registerInstance', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld();
  });

  it('fails when floor2EquipmentRegistry flag is off', async () => {
    const instance = await buildInstance();
    const result = await registerInstance(world, instance);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('flag_disabled');
    }
  });

  it('succeeds with flag enabled and valid instance', async () => {
    enableRegistry(world);
    const instance = await buildInstance();
    const result = await registerInstance(world, instance);
    expect(result.ok).toBe(true);
    expect(getRegistrySize(world)).toBe(1);
  });

  it('rejects unknown schema version', async () => {
    enableRegistry(world);
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    const bad = {
      ...base,
      schemaVersion: 'floor2-equipment-instance/v99' as unknown as typeof base.schemaVersion,
      fingerprint: fp,
    };
    const result = await registerInstance(world, bad as GeneratedEquipmentInstanceV1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_schema');
  });

  it('rejects structurally invalid instance', async () => {
    enableRegistry(world);
    const base = makeInstanceBase({ itemLevel: -1 });
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    const result = await registerInstance(world, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_structure');
  });

  it('rejects instance with wrong fingerprint', async () => {
    enableRegistry(world);
    const base1 = makeInstanceBase({ baseId: 'head.iron-visor' });
    const wrongFp = await computeFingerprint(
      makeInstanceBase({ baseId: 'head.quartermaster-cap' }),
    );
    const bad: GeneratedEquipmentInstanceV1 = { ...base1, fingerprint: wrongFp };
    const result = await registerInstance(world, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_fingerprint');
  });

  it('rejects duplicate instance ID', async () => {
    enableRegistry(world);
    const instance = await buildInstance();
    await registerInstance(world, instance);
    const result = await registerInstance(world, instance);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('duplicate');
    expect(getRegistrySize(world)).toBe(1);
  });

  it('can register multiple distinct instances', async () => {
    enableRegistry(world);
    const i1 = await buildInstance(makeInstanceBase({ instanceId: createInstanceId('run', 1) }));
    const i2 = await buildInstance(makeInstanceBase({ instanceId: createInstanceId('run', 2) }));
    expect((await registerInstance(world, i1)).ok).toBe(true);
    expect((await registerInstance(world, i2)).ok).toBe(true);
    expect(getRegistrySize(world)).toBe(2);
  });

  it('stores a frozen immutable copy (mutation does not affect stored instance)', async () => {
    enableRegistry(world);
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    const instance: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    await registerInstance(world, instance);

    const stored = lookupInstance(world, instance.instanceId)!;
    expect(stored).toBeDefined();
    // The stored object and all nested objects are deeply frozen
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.frozen)).toBe(true);
    expect(Object.isFrozen(stored.frozen.statBonuses)).toBe(true);
    expect(Object.isFrozen(stored.resolvedEffects)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lookupInstance / hasInstance tests
// ---------------------------------------------------------------------------

describe('lookupInstance', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld();
    enableRegistry(world);
  });

  it('returns the registered instance', async () => {
    const instance = await buildInstance();
    await registerInstance(world, instance);
    const found = lookupInstance(world, instance.instanceId);
    expect(found).toBeDefined();
    expect(found?.instanceId).toBe(instance.instanceId);
    expect(found?.frozen.displayName).toBe('Iron Visor');
  });

  it('returns undefined for unknown ID', () => {
    const id = createInstanceId('run', 999);
    expect(lookupInstance(world, id)).toBeUndefined();
  });

  it('works even when flag is off', async () => {
    const instance = await buildInstance();
    await registerInstance(world, instance);
    // Disable flag — reads still work
    world.floor2EquipmentFlags.floor2EquipmentRegistry = false;
    expect(lookupInstance(world, instance.instanceId)).toBeDefined();
  });
});

describe('hasInstance', () => {
  it('returns true for registered ID, false for unknown', async () => {
    const world = enableRegistry(createTestWorld());
    const instance = await buildInstance();
    await registerInstance(world, instance);
    expect(hasInstance(world, instance.instanceId)).toBe(true);
    expect(hasInstance(world, createInstanceId('run', 999))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-world isolation
// ---------------------------------------------------------------------------

describe('per-world isolation', () => {
  it('registries for different worlds are independent', async () => {
    const w1 = enableRegistry(createTestWorld());
    const w2 = enableRegistry(createTestWorld());

    const i1 = await buildInstance(makeInstanceBase({ instanceId: createInstanceId('run', 1) }));
    await registerInstance(w1, i1);

    expect(getRegistrySize(w1)).toBe(1);
    expect(getRegistrySize(w2)).toBe(0);
    expect(lookupInstance(w1, i1.instanceId)).toBeDefined();
    expect(lookupInstance(w2, i1.instanceId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// snapshotRegistry / hydrateRegistry tests
// ---------------------------------------------------------------------------

describe('snapshotRegistry', () => {
  it('returns empty array for a fresh world', () => {
    const world = createTestWorld();
    expect(snapshotRegistry(world)).toHaveLength(0);
  });

  it('returns all registered instances', async () => {
    const world = enableRegistry(createTestWorld());
    const i1 = await buildInstance(makeInstanceBase({ instanceId: createInstanceId('run', 1) }));
    const i2 = await buildInstance(makeUncommonBase({ instanceId: createInstanceId('run', 2) }));
    await registerInstance(world, i1);
    await registerInstance(world, i2);

    const snap = snapshotRegistry(world);
    expect(snap).toHaveLength(2);
    const ids = snap.map((i) => i.instanceId);
    expect(ids).toContain(i1.instanceId);
    expect(ids).toContain(i2.instanceId);
  });

  it('returns a snapshot — modifications to the returned array do not affect the registry', async () => {
    const world = enableRegistry(createTestWorld());
    const instance = await buildInstance();
    await registerInstance(world, instance);

    const snap = snapshotRegistry(world);
    (snap as GeneratedEquipmentInstanceV1[]).pop();
    // Registry is unaffected
    expect(getRegistrySize(world)).toBe(1);
  });
});

describe('hydrateRegistry', () => {
  it('loads valid instances without the generation flag', async () => {
    const world = createTestWorld(); // flag OFF
    const instance = await buildInstance();
    const errors = await hydrateRegistry(world, [instance]);
    expect(errors).toHaveLength(0);
    expect(getRegistrySize(world)).toBe(1);
    expect(lookupInstance(world, instance.instanceId)?.instanceId).toBe(instance.instanceId);
  });

  it('rejects instances with unknown schema versions', async () => {
    const world = createTestWorld();
    const base = makeInstanceBase();
    const fp = await computeFingerprint(base);
    const bad = {
      ...base,
      schemaVersion: 'floor2-equipment-instance/v99' as unknown as typeof base.schemaVersion,
      fingerprint: fp,
    };
    const errors = await hydrateRegistry(world, [bad as GeneratedEquipmentInstanceV1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown schemaVersion');
    expect(getRegistrySize(world)).toBe(0);
  });

  it('rejects structurally invalid instances', async () => {
    const world = createTestWorld();
    const base = makeInstanceBase({ baseId: '' }); // empty baseId
    const fp = await computeFingerprint(base);
    const bad: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    const errors = await hydrateRegistry(world, [bad]);
    expect(errors).toHaveLength(1);
    expect(getRegistrySize(world)).toBe(0);
  });

  it('rejects instances with fingerprint mismatch (tuning drift)', async () => {
    const world = createTestWorld();
    const base = makeInstanceBase({ frozen: makeFrozen({ statBonuses: { armor: 5 } }) });
    const fp = await computeFingerprint(base);
    // Simulate tuning drift: stats changed but fingerprint not updated
    const drifted: GeneratedEquipmentInstanceV1 = {
      ...base,
      frozen: { ...base.frozen, statBonuses: { armor: 99 } },
      fingerprint: fp,
    };
    const errors = await hydrateRegistry(world, [drifted]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('fingerprint mismatch');
    expect(getRegistrySize(world)).toBe(0);
  });

  it('reports duplicates as errors but continues hydrating valid instances', async () => {
    const world = createTestWorld();
    const instance = await buildInstance();
    await hydrateRegistry(world, [instance]);
    // Second hydrate with same ID
    const errors = await hydrateRegistry(world, [instance]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
    expect(getRegistrySize(world)).toBe(1); // still only 1
  });

  it('round-trips snapshotRegistry → hydrateRegistry correctly', async () => {
    const world1 = enableRegistry(createTestWorld());
    const i1 = await buildInstance(makeInstanceBase({ instanceId: createInstanceId('run', 1) }));
    const i2 = await buildInstance(makeUncommonBase({ instanceId: createInstanceId('run', 2) }));
    await registerInstance(world1, i1);
    await registerInstance(world1, i2);

    const snapshot = snapshotRegistry(world1);

    const world2 = createTestWorld(); // flag OFF — hydration bypasses it
    const errors = await hydrateRegistry(world2, snapshot);
    expect(errors).toHaveLength(0);
    expect(getRegistrySize(world2)).toBe(2);
    expect(lookupInstance(world2, i1.instanceId)?.baseId).toBe(i1.baseId);
    expect(lookupInstance(world2, i2.instanceId)?.rarity).toBe('uncommon');
  });

  it('rejects non-array input', async () => {
    const world = createTestWorld();
    const errors = await hydrateRegistry(world, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must be an array');
    expect(getRegistrySize(world)).toBe(0);
  });

  it('collects error and continues when an element is null', async () => {
    const world = createTestWorld();
    const instance = await buildInstance();
    const errors = await hydrateRegistry(world, [null, instance]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('index 0');
    expect(getRegistrySize(world)).toBe(1); // second element still hydrates
  });

  it('collects error and continues when frozen is missing', async () => {
    const world = createTestWorld();
    const { frozen: _frozen, ...noFrozen } = await buildInstance();
    const errors = await hydrateRegistry(world, [noFrozen]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('frozen');
    expect(getRegistrySize(world)).toBe(0);
  });

  it('collects error and continues when resolvedEffects contains a null', async () => {
    const world = createTestWorld();
    const instance = await buildInstance();
    const errors = await hydrateRegistry(world, [
      { ...instance, resolvedEffects: [null] },
    ]);
    expect(errors).toHaveLength(1);
    expect(getRegistrySize(world)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Enhancement level bounds
// ---------------------------------------------------------------------------

describe('enhancement level constants', () => {
  it('ENHANCEMENT_MIN is 0 and ENHANCEMENT_MAX is 5', () => {
    expect(ENHANCEMENT_MIN).toBe(0);
    expect(ENHANCEMENT_MAX).toBe(5);
  });

  it('valid enhancement levels 0..5 pass structural validation', async () => {
    for (let n = 0; n <= 5; n++) {
      const base = makeInstanceBase({ enhancementLevel: n as 0 | 1 | 2 | 3 | 4 | 5 });
      const fp = await computeFingerprint(base);
      const instance: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
      expect(validateInstanceStructure(instance)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Rarity effect budget
// ---------------------------------------------------------------------------

describe('RARITY_EFFECT_BUDGET', () => {
  it('matches the spec (0/1/2 for common/uncommon/rare)', () => {
    expect(RARITY_EFFECT_BUDGET.common).toBe(0);
    expect(RARITY_EFFECT_BUDGET.uncommon).toBe(1);
    expect(RARITY_EFFECT_BUDGET.rare).toBe(2);
  });

  it('rare item can use one two-unit effect', async () => {
    const base = makeInstanceBase({
      rarity: 'rare',
      resolvedEffects: [{ effectId: 'major-armor', magnitude: 15, units: 2 }],
    });
    const fp = await computeFingerprint(base);
    const instance: GeneratedEquipmentInstanceV1 = { ...base, fingerprint: fp };
    expect(validateInstanceStructure(instance)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isValidFingerprintV1
// ---------------------------------------------------------------------------

describe('isValidFingerprintV1', () => {
  it('returns true for a valid 64-char hex fingerprint', async () => {
    const fp = await computeFingerprint(makeInstanceBase());
    expect(isValidFingerprintV1(fp)).toBe(true);
  });

  it('returns false for malformed strings', () => {
    expect(isValidFingerprintV1('sha256:tooshort')).toBe(false);
    expect(isValidFingerprintV1('md5:abc')).toBe(false);
    expect(isValidFingerprintV1('')).toBe(false);
    expect(isValidFingerprintV1('sha256:' + 'g'.repeat(64))).toBe(false); // non-hex
  });
});
