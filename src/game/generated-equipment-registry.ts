/**
 * Generated Equipment Registry — world-owned, keyed by stable instance identity.
 *
 * Authority: .specify/specs/equipment-system.md §Floor 2 Generated Equipment Contract
 * Decision:  docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md
 *
 * This module is the single source of truth for full generated-equipment instance
 * records. All other containers (bag, equipped slots, reward bundles, shop stock,
 * carryover) store instanceId references only.
 *
 * The registry is guarded by `world.floor2EquipmentFlags.floor2EquipmentRegistry`.
 * Registration is blocked when the flag is off; lookups and snapshots always work
 * (disabling stops generation, not reads — persisted records are preserved).
 *
 * ## Usage
 *
 * ```typescript
 * // At floor-load / generation time (async):
 * const id = createInstanceId(makeRunKey(world.seed), ordinal++);
 * const instanceWithoutFp: Omit<GeneratedEquipmentInstanceV1, 'fingerprint'> = { ... };
 * const fp = await computeFingerprint(instanceWithoutFp);
 * const instance = { ...instanceWithoutFp, fingerprint: fp };
 * const result = await registerInstance(world, instance);
 *
 * // At any time (sync):
 * const found = lookupInstance(world, id);
 * const all = snapshotRegistry(world);
 *
 * // During carryover / hydration (async):
 * await hydrateRegistry(world, savedInstances);
 * ```
 */

import type { GameWorld } from '../core/world.js';
import {
  KNOWN_GENERATED_SCHEMA_VERSION,
  RARITY_EFFECT_BUDGET,
  ENHANCEMENT_MIN,
  ENHANCEMENT_MAX,
  isValidGeneratedInstanceId,
  isKnownGeneratedSchemaVersion,
  isValidFingerprintV1,
} from '../shared/generated-equipment-types.js';
import type {
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentInstanceV1,
  EquipmentFingerprintV1,
  GeneratedEquipmentRarity,
} from '../shared/generated-equipment-types.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { isValidStatId } from '../shared/stats.js';

// ---------------------------------------------------------------------------
// Side-map storage
// ---------------------------------------------------------------------------

/**
 * Per-world map from stable instance ID to the full immutable instance record.
 * Uses WeakMap so the registry is automatically cleaned up when the world is GC'd.
 */
const registryMap = new WeakMap<
  GameWorld,
  Map<GeneratedEquipmentInstanceId, GeneratedEquipmentInstanceV1>
>();

function getMap(world: GameWorld): Map<GeneratedEquipmentInstanceId, GeneratedEquipmentInstanceV1> {
  let map = registryMap.get(world);
  if (!map) {
    map = new Map();
    registryMap.set(world, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Deterministic instance ID creation
// ---------------------------------------------------------------------------

/**
 * Create a stable `GeneratedEquipmentInstanceId` from a run key and ordinal.
 *
 * - `runKey` must match `/^[a-z0-9][a-z0-9._-]{0,127}$/`. Use `makeRunKey`
 *   from `generated-equipment-types.ts` to sanitize a numeric seed.
 * - `ordinal` must be a non-negative integer.
 *
 * The same (runKey, ordinal) pair always produces the same ID. It never uses
 * wall-clock time. Per-run, increment ordinal for each new instance.
 */
export function createInstanceId(runKey: string, ordinal: number): GeneratedEquipmentInstanceId {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`createInstanceId: ordinal must be a non-negative integer, got ${ordinal}`);
  }
  const instanceId = `gei:v1:${runKey}:${ordinal}`;
  if (!isValidGeneratedInstanceId(instanceId)) {
    throw new Error(`createInstanceId: runKey "${runKey}" is invalid`);
  }
  return instanceId;
}

// ---------------------------------------------------------------------------
// Canonical JSON for fingerprinting
// ---------------------------------------------------------------------------

export { canonicalJson };

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

/**
 * Compute the V1 fingerprint for an instance record (without its fingerprint).
 *
 * Async because it uses the Web Crypto API (`globalThis.crypto.subtle`), which
 * works in both Node.js 18+ (tests) and modern browsers. Call this once during
 * instance generation or hydration — not in the tight per-frame loop.
 */
export async function computeFingerprint(
  instance: Omit<GeneratedEquipmentInstanceV1, 'fingerprint'>,
): Promise<EquipmentFingerprintV1> {
  const json = canonicalJson(instance);
  const encoded = new TextEncoder().encode(json);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}` as EquipmentFingerprintV1;
}

/**
 * Validate that a stored instance's fingerprint matches its content.
 *
 * Returns `true` when the fingerprint is correct (no tampering or tuning
 * drift). Returns `false` if the recomputed hash differs from the stored one.
 *
 * Use this for:
 * - Tuning-drift detection (did a catalog change alter a frozen record?).
 * - Post-save / post-carryover integrity checks.
 *
 * Not called on every lookup — only at explicit validation points.
 */
export async function validateFingerprint(
  instance: GeneratedEquipmentInstanceV1,
): Promise<boolean> {
  const { fingerprint, ...rest } = instance;
  const expected = await computeFingerprint(rest);
  return fingerprint === expected;
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Typed failure reason for registration. */
export type RegisterFailureReason =
  | 'flag_disabled'
  | 'unknown_schema'
  | 'invalid_id'
  | 'invalid_structure'
  | 'invalid_fingerprint_format'
  | 'invalid_fingerprint'
  | 'duplicate';

/** Result of a `registerInstance` call. */
export type RegisterResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RegisterFailureReason; readonly detail?: string };

/**
 * Validate the structural invariants of a V1 instance (synchronous).
 *
 * Checked invariants:
 * - schemaVersion === KNOWN_GENERATED_SCHEMA_VERSION
 * - instanceId matches valid format
 * - contentRevision is a non-negative integer
 * - baseId is a non-empty string
 * - itemLevel is a positive integer
 * - rarity is one of common/uncommon/rare
 * - enhancementLevel is an integer in [ENHANCEMENT_MIN..ENHANCEMENT_MAX]
 * - resolvedEffects: each unit is 1 or 2; effectIds unique; sum of units = budget
 * - frozen.displayName non-empty
 * - frozen.artKey non-empty
 * - frozen.statBonuses keys are valid StatIds; values are finite numbers
 * - fingerprint matches valid format (cryptographic correctness validated separately)
 *
 * Returns null on success, or a string describing the first violation.
 */
export function validateInstanceStructure(instance: GeneratedEquipmentInstanceV1): string | null {
  if (instance.schemaVersion !== KNOWN_GENERATED_SCHEMA_VERSION) {
    return `unknown schemaVersion: "${instance.schemaVersion}"`;
  }
  if (!isValidGeneratedInstanceId(instance.instanceId)) {
    return `invalid instanceId format: "${instance.instanceId}"`;
  }
  if (!Number.isInteger(instance.contentRevision) || instance.contentRevision < 0) {
    return `contentRevision must be a non-negative integer, got ${instance.contentRevision}`;
  }
  if (typeof instance.baseId !== 'string' || instance.baseId.trim() === '') {
    return `baseId must be a non-empty string`;
  }
  if (!Number.isInteger(instance.itemLevel) || instance.itemLevel < 1) {
    return `itemLevel must be a positive integer, got ${instance.itemLevel}`;
  }
  const validRarities: GeneratedEquipmentRarity[] = ['common', 'uncommon', 'rare'];
  if (!validRarities.includes(instance.rarity)) {
    return `invalid rarity: "${instance.rarity}"`;
  }
  if (
    !Number.isInteger(instance.enhancementLevel) ||
    instance.enhancementLevel < ENHANCEMENT_MIN ||
    instance.enhancementLevel > ENHANCEMENT_MAX
  ) {
    return `enhancementLevel must be an integer in [${ENHANCEMENT_MIN}..${ENHANCEMENT_MAX}], got ${instance.enhancementLevel}`;
  }

  // Validate resolvedEffects against rarity budget
  const budget = RARITY_EFFECT_BUDGET[instance.rarity];
  let totalUnits = 0;
  const seenEffectIds = new Set<string>();
  for (const effect of instance.resolvedEffects) {
    const units = 'units' in effect ? effect.units : effect.unitCost;
    if (units !== 1 && units !== 2) {
      return `effect "${effect.effectId}" has invalid units: ${String(units)} (must be 1 or 2)`;
    }
    const magnitude =
      'magnitude' in effect ? effect.magnitude : 'value' in effect ? effect.value : 0;
    if (!Number.isFinite(magnitude)) {
      return `effect "${effect.effectId}" magnitude must be finite, got ${String(magnitude)}`;
    }
    if (seenEffectIds.has(effect.effectId)) {
      return `duplicate effectId in resolvedEffects: "${effect.effectId}"`;
    }
    seenEffectIds.add(effect.effectId);
    totalUnits += units;
  }
  if (totalUnits !== budget) {
    return `resolvedEffects total units ${totalUnits} does not match rarity budget ${budget} for "${instance.rarity}"`;
  }

  // Validate frozen fields
  const { frozen } = instance;
  if (frozen === null || typeof frozen !== 'object') {
    return `frozen must be an object`;
  }
  if (typeof frozen.displayName !== 'string' || frozen.displayName.trim() === '') {
    return `frozen.displayName must be a non-empty string`;
  }
  if (typeof frozen.artKey !== 'string' || frozen.artKey.trim() === '') {
    return `frozen.artKey must be a non-empty string`;
  }
  if (frozen.statBonuses === null || typeof frozen.statBonuses !== 'object') {
    return `frozen.statBonuses must be an object`;
  }
  for (const [statId, value] of Object.entries(frozen.statBonuses)) {
    if (!isValidStatId(statId)) {
      return `frozen.statBonuses contains invalid StatId: "${statId}"`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `frozen.statBonuses["${statId}"] must be a finite number, got ${value}`;
    }
  }

  // Validate fingerprint format (cryptographic correctness is async)
  if (!isValidFingerprintV1(instance.fingerprint)) {
    return `fingerprint has invalid format: "${instance.fingerprint}" (expected sha256:<64 hex>)`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Deep-clone and recursive freeze
// ---------------------------------------------------------------------------

/**
 * Deep-clone `value` and recursively freeze every plain object and array in
 * the clone. Primitives (string, number, boolean, null) are returned as-is.
 *
 * This is used to ensure stored records are fully immutable and that a
 * caller cannot mutate registered content after registration or hydration,
 * even through nested object or array references.
 */
function deepCloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze((value as unknown[]).map(deepCloneAndFreeze)) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    clone[key] = deepCloneAndFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(clone) as T;
}

// ---------------------------------------------------------------------------
// Persisted-data shape guard
// ---------------------------------------------------------------------------

/**
 * Minimal shape guard for a raw persisted instance record.
 *
 * Verifies that the value is a plain object with the nested fields that
 * `validateInstanceStructure` would dereference without null guards.
 * Returns `null` if shape is structurally safe to proceed with validation,
 * or a descriptive error string if not.
 */
function guardRawInstance(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'element is not a plain object';
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['schemaVersion'] !== 'string') return 'missing or non-string schemaVersion';
  if (typeof r['instanceId'] !== 'string') return 'missing or non-string instanceId';
  if (typeof r['fingerprint'] !== 'string') return 'missing or non-string fingerprint';

  // frozen must be a plain (non-null, non-array) object
  if (r['frozen'] === null || typeof r['frozen'] !== 'object' || Array.isArray(r['frozen'])) {
    return 'frozen must be a plain object';
  }
  const frozen = r['frozen'] as Record<string, unknown>;
  if (
    frozen['statBonuses'] === null ||
    typeof frozen['statBonuses'] !== 'object' ||
    Array.isArray(frozen['statBonuses'])
  ) {
    return 'frozen.statBonuses must be a plain object';
  }

  // resolvedEffects must be an array with non-null object elements
  if (!Array.isArray(r['resolvedEffects'])) {
    return 'resolvedEffects must be an array';
  }
  for (let i = 0; i < (r['resolvedEffects'] as unknown[]).length; i++) {
    const eff = (r['resolvedEffects'] as unknown[])[i];
    if (eff === null || typeof eff !== 'object' || Array.isArray(eff)) {
      return `resolvedEffects[${i}] is not a plain object`;
    }
  }

  return null;
}

/**
 * Register a generated equipment instance in the world-owned registry.
 *
 * This is the only way to add instances to the registry. Direct map mutation
 * is forbidden.
 *
 * Steps (in order):
 * 1. Check `floor2EquipmentRegistry` feature flag.
 * 2. Check schema version (unknown versions fail closed).
 * 3. Validate structural invariants synchronously.
 * 4. Validate fingerprint cryptographically (async — ensures no tampering).
 * 5. Reject duplicate instance IDs.
 * 6. Store a frozen copy of the instance.
 *
 * The stored record is Object.freeze()'d to prevent accidental mutation.
 *
 * @returns { ok: true } on success, or { ok: false, reason, detail? } on failure.
 */
export async function registerInstance(
  world: GameWorld,
  instance: GeneratedEquipmentInstanceV1,
): Promise<RegisterResult> {
  // 1. Feature flag
  if (!world.floor2EquipmentFlags.floor2EquipmentRegistry) {
    return { ok: false, reason: 'flag_disabled' };
  }

  // 2. Schema version (fail closed for unknown versions)
  if (!isKnownGeneratedSchemaVersion(instance.schemaVersion)) {
    return {
      ok: false,
      reason: 'unknown_schema',
      detail: `"${instance.schemaVersion}" is not a supported schema version`,
    };
  }

  // Deep-clone before any further validation so mutations to the caller's
  // object cannot race with or affect fingerprinting or the stored record.
  const cloned = deepCloneAndFreeze(instance);

  // 3. Structural validation (sync) — against the clone
  const structureError = validateInstanceStructure(cloned);
  if (structureError !== null) {
    return { ok: false, reason: 'invalid_structure', detail: structureError };
  }

  // 4. Fingerprint cryptographic validation (async) — against the clone
  const fingerprintOk = await validateFingerprint(cloned);
  if (!fingerprintOk) {
    return {
      ok: false,
      reason: 'invalid_fingerprint',
      detail: 'stored fingerprint does not match recomputed SHA-256 of instance content',
    };
  }

  // 5. Duplicate check
  const map = getMap(world);
  if (map.has(cloned.instanceId)) {
    return {
      ok: false,
      reason: 'duplicate',
      detail: `instance "${cloned.instanceId}" is already registered`,
    };
  }

  // 6. Store the already-frozen deep clone (deepCloneAndFreeze recursively froze it)
  map.set(cloned.instanceId, cloned);
  return { ok: true };
}

/**
 * Look up a generated instance by its stable ID.
 *
 * Read path is always allowed regardless of feature-flag state (disabling the
 * flag stops generation, not reads). Returns `undefined` if not found.
 *
 * O(1) lookup.
 */
export function lookupInstance(
  world: GameWorld,
  instanceId: GeneratedEquipmentInstanceId,
): GeneratedEquipmentInstanceV1 | undefined {
  return getMap(world).get(instanceId);
}

/**
 * Check whether a given instance ID is present in the registry.
 *
 * Read path — always allowed regardless of flag state.
 */
export function hasInstance(world: GameWorld, instanceId: GeneratedEquipmentInstanceId): boolean {
  return getMap(world).has(instanceId);
}

/**
 * Return the number of registered instances for this world.
 *
 * Primarily used in tests. Read path — always allowed.
 */
export function getRegistrySize(world: GameWorld): number {
  return getMap(world).size;
}

// ---------------------------------------------------------------------------
// Serialization boundary
// ---------------------------------------------------------------------------

/**
 * Return an immutable snapshot of all registered instances.
 *
 * Provides the serialization-facing boundary. The carryover / save-load slice
 * (B3) persists this array and passes it back to `hydrateRegistry` on load.
 *
 * Read path — always allowed regardless of flag state. Does not modify registry.
 */
export function snapshotRegistry(world: GameWorld): readonly GeneratedEquipmentInstanceV1[] {
  return Array.from(getMap(world).values());
}

/**
 * Hydrate the registry from a persisted snapshot.
 *
 * Intended for save/load and floor carryover (B3). Validates structure and
 * fingerprint for each instance. Instances that pass are registered; failures
 * are collected and returned as an array of errors.
 *
 * Does NOT check the `floor2EquipmentRegistry` flag — hydration must work even
 * when the generation flag is off so temporarily disabling a slice does not
 * destroy persisted state (ADR 0065 DEC-009).
 *
 * Unknown schema versions are skipped (fail-closed) and reported as errors.
 *
 * @returns Array of error strings for any instance that failed hydration.
 *          Empty array = all instances hydrated successfully.
 */
export async function hydrateRegistry(world: GameWorld, instances: unknown): Promise<string[]> {
  const errors: string[] = [];
  const map = getMap(world);

  if (!Array.isArray(instances)) {
    return ['hydrateRegistry: instances argument must be an array'];
  }

  for (let idx = 0; idx < instances.length; idx++) {
    const raw: unknown = instances[idx];

    // Shape guard: ensure basic structure before deeper validation
    const shapeError = guardRawInstance(raw);
    if (shapeError !== null) {
      errors.push(`instance at index ${idx}: ${shapeError}`);
      continue;
    }

    const instance = raw as GeneratedEquipmentInstanceV1;

    // Unknown schema versions fail closed
    if (!isKnownGeneratedSchemaVersion(instance.schemaVersion)) {
      errors.push(`skipped instance with unknown schemaVersion: "${instance.schemaVersion}"`);
      continue;
    }

    // Deep-clone before validation and storage so caller mutations cannot
    // affect the registered record.
    const cloned = deepCloneAndFreeze(instance);

    // Structural validation
    const structureError = validateInstanceStructure(cloned);
    if (structureError !== null) {
      errors.push(`invalid structure for instance "${cloned.instanceId}": ${structureError}`);
      continue;
    }

    // Fingerprint validation
    const fingerprintOk = await validateFingerprint(cloned);
    if (!fingerprintOk) {
      errors.push(
        `fingerprint mismatch for instance "${cloned.instanceId}": tuning drift detected`,
      );
      continue;
    }

    // Duplicate check (warn but skip, don't fail the whole hydration)
    if (map.has(cloned.instanceId)) {
      errors.push(`duplicate instance "${cloned.instanceId}" skipped during hydration`);
      continue;
    }

    map.set(cloned.instanceId, cloned);
  }

  return errors;
}
