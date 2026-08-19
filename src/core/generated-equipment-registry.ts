import {
  ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION,
  parseGeneratedEquipmentInstanceId,
  type ActiveWeaponClassSkillTag,
  type ActiveWeaponCombatOverridesV1,
  type ActiveWeaponSnapshotCreateInputV1,
  type ActiveWeaponSnapshotV1,
  type ActiveWeaponTypeSkillTag,
  type EquipmentFingerprintV1,
  type FrozenEquipmentFieldsV1,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentEnhancementLevel,
  type GeneratedEquipmentGenerationPolicyV1,
  type GeneratedEquipmentGenerationV1,
  type GeneratedEquipmentInstanceId,
  type GeneratedEquipmentInstanceV1,
  type GeneratedEquipmentRarity,
  type GeneratedEquipmentRegistrySnapshotV1,
  type ResolvedEquipmentEffectV1,
} from '../shared/generated-equipment-types.js';
import { canonicalJson, deepFreeze, sha256Hex } from '../shared/canonical-json.js';
import { isValidSlotId, type EquipmentSlotId } from '../shared/equipment-slots.js';
import { isValidStatId, type StatId } from '../shared/stats.js';
import {
  MeleeStyle,
  WeaponType,
  type MeleeStyleValue,
  type WeaponTypeValue,
} from '../shared/constants.js';
import {
  isWeaponClassSkillId,
  isWeaponTypeSkillId,
  type WeaponClassSkillId,
  type WeaponTypeSkillId,
} from '../shared/weapon-skills.js';
import { getWeaponDef, type WeaponDef } from '../shared/weaponDefs.js';

export type GeneratedEquipmentRegistryErrorCode =
  | 'duplicate-instance'
  | 'fingerprint-mismatch'
  | 'invalid-payload'
  | 'illegal-override'
  | 'not-found'
  | 'ordinal-gap'
  | 'registry-not-empty'
  | 'registry-unconfigured'
  | 'run-key-mismatch'
  | 'tuning-drift'
  | 'unsupported-version';

export class GeneratedEquipmentRegistryError extends Error {
  constructor(
    readonly code: GeneratedEquipmentRegistryErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'GeneratedEquipmentRegistryError';
  }
}

export interface GeneratedEquipmentRegistry {
  readonly runKey: string | null;
  readonly generationPolicy: GeneratedEquipmentGenerationPolicyV1;
  readonly generationPolicyFingerprint: EquipmentFingerprintV1;
}

export interface GeneratedEquipmentRegistryWorld {
  readonly generatedEquipmentRegistry: GeneratedEquipmentRegistry;
}

export interface CreateGeneratedEquipmentRegistryOptions {
  readonly runKey?: string;
  readonly generationPolicy?: GeneratedEquipmentGenerationPolicyV1;
}

interface RegistryState {
  readonly instances: Map<GeneratedEquipmentInstanceId, GeneratedEquipmentInstanceV1>;
  nextOrdinal: number;
}

interface InstanceValidationOptions {
  readonly expectedRunKey?: string;
  readonly expectedPolicy?: GeneratedEquipmentGenerationPolicyV1;
  readonly expectedPolicyFingerprint?: EquipmentFingerprintV1;
}

export interface ActiveWeaponSnapshotValidationOptions {
  readonly expectedInstanceId?: GeneratedEquipmentInstanceId;
  readonly expectedSourceWeaponDefId?: string;
}

const ACTIVE_WEAPON_SNAPSHOT_OVERRIDE_KEYS = new Set<keyof WeaponDef>([
  'name',
  'weaponType',
  'baseDamage',
  'cooldownMs',
  'range',
  'projectileSpeed',
  'aoeRadius',
  'durationMs',
  'beamTickMs',
  'beamLength',
  'trapArmMs',
  'trapTriggerRadius',
  'trapExplosionRadius',
  'returnSpeed',
  'maxRange',
  'swingArcDeg',
  'meleeStyle',
  'headRadius',
  'shaftDamageMult',
  'knockback',
  'pierce',
  'bounceCount',
  'goreFactor',
  'baseAccuracy',
  'weaponClassSkillId',
  'weaponTypeSkillId',
]);

const DEFAULT_POLICY_DATA: GeneratedEquipmentGenerationPolicyV1 = {
  schemaVersion: GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION,
  generationVersion: GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
  rarityInherentScalars: {
    common: 1,
    uncommon: 1.05,
    rare: 1.1,
  },
  rarityEffectUnits: {
    common: 0,
    uncommon: 1,
    rare: 2,
  },
  enhancementPercentPerLevel: 0.05,
  maximumEnhancementLevel: 5,
  normalizationMode: 'non-negative-integer-nearest-half-up/v1',
  drawOrder: [
    'base-template',
    'item-level',
    'inherent-scaling',
    'rarity-scalar-and-budget',
    'enhancement',
    'affixes-and-effects',
    'freeze',
  ],
};

export const DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1 = deepFreeze(DEFAULT_POLICY_DATA);

const registryStates = new WeakMap<GeneratedEquipmentRegistry, RegistryState>();
const RUN_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function fail(code: GeneratedEquipmentRegistryErrorCode, message: string, path: string): never {
  throw new GeneratedEquipmentRegistryError(code, message, path);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail('invalid-payload', 'Expected a plain object', path);
  }
  return value as Record<string, unknown>;
}

function requireKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(
      'invalid-payload',
      `Expected keys [${expected.join(', ')}], received [${actual.join(', ')}]`,
      path,
    );
  }
}

function requireVersion(value: unknown, expected: string, path: string): asserts value is string {
  if (value !== expected) {
    fail('unsupported-version', `Unsupported version ${String(value)}; expected ${expected}`, path);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('invalid-payload', 'Expected a non-empty string', path);
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-payload', 'Expected a finite number', path);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) {
    fail('invalid-payload', 'Expected a non-negative number', path);
  }
  return number;
}

function requireInteger(value: unknown, minimum: number, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (!Number.isInteger(number) || number < minimum) {
    fail('invalid-payload', `Expected an integer >= ${minimum}`, path);
  }
  return number;
}

function requireRunKey(value: unknown, path: string): string {
  const runKey = requireNonEmptyString(value, path);
  if (!RUN_KEY_PATTERN.test(runKey)) {
    fail(
      'invalid-payload',
      'Run key must be 1-128 lowercase alphanumeric, dot, underscore, or hyphen characters',
      path,
    );
  }
  return runKey;
}

function requireFingerprint(value: unknown, path: string): EquipmentFingerprintV1 {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    fail('invalid-payload', 'Expected a lowercase sha256:<64 hex> fingerprint', path);
  }
  return value as EquipmentFingerprintV1;
}

function requireGeneratedEquipmentInstanceId(
  value: unknown,
  path: string,
): GeneratedEquipmentInstanceId {
  if (typeof value !== 'string') {
    fail('invalid-payload', 'Expected a generated equipment instance ID', path);
  }
  const parsed = parseGeneratedEquipmentInstanceId(value);
  if (!parsed) {
    fail('invalid-payload', 'Expected gei:v1:<runKey>:<ordinal> instance ID', path);
  }
  requireRunKey(parsed.runKey, `${path}.runKey`);
  requireInteger(parsed.ordinal, 0, `${path}.ordinal`);
  return value as GeneratedEquipmentInstanceId;
}

function weaponClassSkillTag(skillId: WeaponClassSkillId): ActiveWeaponClassSkillTag {
  return `weapon-class:${skillId}`;
}

function weaponTypeSkillTag(skillId: WeaponTypeSkillId): ActiveWeaponTypeSkillTag {
  return `weapon-type:${skillId}`;
}

export function canonicalActiveWeaponSkillTags(
  weaponClassSkillId: WeaponClassSkillId,
  weaponTypeSkillId: WeaponTypeSkillId,
): readonly [ActiveWeaponClassSkillTag, ActiveWeaponTypeSkillTag] {
  return Object.freeze([
    weaponClassSkillTag(weaponClassSkillId),
    weaponTypeSkillTag(weaponTypeSkillId),
  ]);
}

function requireStringArray(value: unknown, path: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail('invalid-payload', allowEmpty ? 'Expected an array' : 'Expected a non-empty array', path);
  }
  const result = value.map((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    fail('invalid-payload', 'Duplicate values are not allowed', path);
  }
  return Object.freeze(result);
}

function requireSlots(value: unknown, path: string): readonly EquipmentSlotId[] {
  const strings = requireStringArray(value, path, false);
  const slots: EquipmentSlotId[] = [];
  for (let index = 0; index < strings.length; index += 1) {
    const slot = strings[index] ?? '';
    if (!isValidSlotId(slot)) {
      fail('invalid-payload', `Unknown equipment slot ${slot}`, `${path}[${index}]`);
    }
    slots.push(slot);
  }
  return Object.freeze(slots);
}

function requireRarity(value: unknown, path: string): GeneratedEquipmentRarity {
  if (value !== 'common' && value !== 'uncommon' && value !== 'rare') {
    fail('invalid-payload', 'Expected common, uncommon, or rare', path);
  }
  return value;
}

function requireEnhancement(
  value: unknown,
  maximum: GeneratedEquipmentEnhancementLevel,
  path: string,
): GeneratedEquipmentEnhancementLevel {
  const level = requireInteger(value, 0, path);
  if (level > maximum || level > 5) {
    fail('invalid-payload', `Enhancement must not exceed +${maximum}`, path);
  }
  return level as GeneratedEquipmentEnhancementLevel;
}

function requireWeaponType(value: unknown, path: string): WeaponTypeValue {
  switch (value) {
    case WeaponType.MELEE:
    case WeaponType.RANGED:
    case WeaponType.MAGIC:
    case WeaponType.THROWN:
    case WeaponType.BEAM:
    case WeaponType.TRAP:
      return value;
    default:
      fail('invalid-payload', 'Unknown weapon type', path);
  }
}

function requireMeleeStyle(value: unknown, path: string): MeleeStyleValue {
  if (value !== MeleeStyle.SLASH && value !== MeleeStyle.STAB) {
    fail('invalid-payload', 'Unknown melee style', path);
  }
  return value;
}

function requireWeaponClassSkill(value: unknown, path: string): WeaponClassSkillId {
  const id = requireNonEmptyString(value, path);
  if (!isWeaponClassSkillId(id)) {
    fail('invalid-payload', `Unknown weapon class skill ${id}`, path);
  }
  return id;
}

function requireWeaponTypeSkill(value: unknown, path: string): WeaponTypeSkillId {
  const id = requireNonEmptyString(value, path);
  if (!isWeaponTypeSkillId(id)) {
    fail('invalid-payload', `Unknown weapon type skill ${id}`, path);
  }
  return id;
}

function requireBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number {
  const number = requireFiniteNumber(value, path);
  if (number < minimum || number > maximum) {
    fail('invalid-payload', `Expected a number in [${minimum}, ${maximum}]`, path);
  }
  return number;
}

export function validateActiveWeaponSnapshotV1(
  value: unknown,
  options: ActiveWeaponSnapshotValidationOptions = {},
): ActiveWeaponSnapshotV1 {
  const path = '$.activeWeaponSnapshot';
  const record = requireRecord(value, path);
  requireKeys(
    record,
    [
      'schemaVersion',
      'generatedEquipmentInstanceId',
      'id',
      'sourceWeaponDefId',
      'canonicalSkillTags',
      'fingerprint',
      'name',
      'weaponType',
      'baseDamage',
      'cooldownMs',
      'range',
      'projectileSpeed',
      'aoeRadius',
      'durationMs',
      'beamTickMs',
      'beamLength',
      'trapArmMs',
      'trapTriggerRadius',
      'trapExplosionRadius',
      'returnSpeed',
      'maxRange',
      'swingArcDeg',
      'meleeStyle',
      'headRadius',
      'shaftDamageMult',
      'knockback',
      'pierce',
      'bounceCount',
      'goreFactor',
      'baseAccuracy',
      'weaponClassSkillId',
      'weaponTypeSkillId',
    ],
    path,
  );
  requireVersion(
    record.schemaVersion,
    ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );
  const cooldownMs = requireInteger(record.cooldownMs, 1, `${path}.cooldownMs`);
  const pierce = requireInteger(record.pierce, 0, `${path}.pierce`);
  const bounceCount = requireInteger(record.bounceCount, 0, `${path}.bounceCount`);
  const generatedEquipmentInstanceId = requireGeneratedEquipmentInstanceId(
    record.generatedEquipmentInstanceId,
    `${path}.generatedEquipmentInstanceId`,
  );
  if (
    options.expectedInstanceId !== undefined &&
    generatedEquipmentInstanceId !== options.expectedInstanceId
  ) {
    fail(
      'invalid-payload',
      `Snapshot instance ID ${generatedEquipmentInstanceId} does not match expected ${options.expectedInstanceId}`,
      `${path}.generatedEquipmentInstanceId`,
    );
  }
  const id = requireNonEmptyString(record.id, `${path}.id`);
  const sourceWeaponDefId = requireNonEmptyString(
    record.sourceWeaponDefId,
    `${path}.sourceWeaponDefId`,
  );
  if (id !== sourceWeaponDefId) {
    fail('invalid-payload', 'Snapshot id must match sourceWeaponDefId', `${path}.id`);
  }
  if (options.expectedSourceWeaponDefId !== undefined && id !== options.expectedSourceWeaponDefId) {
    fail(
      'invalid-payload',
      `Snapshot source weapon ${id} does not match expected ${options.expectedSourceWeaponDefId}`,
      `${path}.sourceWeaponDefId`,
    );
  }
  if (getWeaponDef(id) === undefined) {
    fail('invalid-payload', `Unknown source weapon definition ${id}`, `${path}.sourceWeaponDefId`);
  }
  const weaponClassSkillId = requireWeaponClassSkill(
    record.weaponClassSkillId,
    `${path}.weaponClassSkillId`,
  );
  const weaponTypeSkillId = requireWeaponTypeSkill(
    record.weaponTypeSkillId,
    `${path}.weaponTypeSkillId`,
  );
  const canonicalSkillTags = canonicalActiveWeaponSkillTags(weaponClassSkillId, weaponTypeSkillId);
  if (!Array.isArray(record.canonicalSkillTags) || record.canonicalSkillTags.length !== 2) {
    fail(
      'invalid-payload',
      'canonicalSkillTags must be a 2-entry [weapon-class, weapon-type] tuple',
      `${path}.canonicalSkillTags`,
    );
  }
  if (
    record.canonicalSkillTags[0] !== canonicalSkillTags[0] ||
    record.canonicalSkillTags[1] !== canonicalSkillTags[1]
  ) {
    fail(
      'invalid-payload',
      `canonicalSkillTags must equal [${canonicalSkillTags.join(', ')}]`,
      `${path}.canonicalSkillTags`,
    );
  }
  const snapshotWithoutFingerprint = deepFreeze({
    schemaVersion: ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
    generatedEquipmentInstanceId,
    id,
    sourceWeaponDefId,
    canonicalSkillTags,
    name: requireNonEmptyString(record.name, `${path}.name`),
    weaponType: requireWeaponType(record.weaponType, `${path}.weaponType`),
    baseDamage: requireNonNegativeNumber(record.baseDamage, `${path}.baseDamage`),
    cooldownMs,
    range: requireNonNegativeNumber(record.range, `${path}.range`),
    projectileSpeed: requireNonNegativeNumber(record.projectileSpeed, `${path}.projectileSpeed`),
    aoeRadius: requireNonNegativeNumber(record.aoeRadius, `${path}.aoeRadius`),
    durationMs: requireNonNegativeNumber(record.durationMs, `${path}.durationMs`),
    beamTickMs: requireNonNegativeNumber(record.beamTickMs, `${path}.beamTickMs`),
    beamLength: requireNonNegativeNumber(record.beamLength, `${path}.beamLength`),
    trapArmMs: requireNonNegativeNumber(record.trapArmMs, `${path}.trapArmMs`),
    trapTriggerRadius: requireNonNegativeNumber(
      record.trapTriggerRadius,
      `${path}.trapTriggerRadius`,
    ),
    trapExplosionRadius: requireNonNegativeNumber(
      record.trapExplosionRadius,
      `${path}.trapExplosionRadius`,
    ),
    returnSpeed: requireNonNegativeNumber(record.returnSpeed, `${path}.returnSpeed`),
    maxRange: requireNonNegativeNumber(record.maxRange, `${path}.maxRange`),
    swingArcDeg: requireNonNegativeNumber(record.swingArcDeg, `${path}.swingArcDeg`),
    meleeStyle: requireMeleeStyle(record.meleeStyle, `${path}.meleeStyle`),
    headRadius: requireNonNegativeNumber(record.headRadius, `${path}.headRadius`),
    shaftDamageMult: requireNonNegativeNumber(record.shaftDamageMult, `${path}.shaftDamageMult`),
    knockback: requireNonNegativeNumber(record.knockback, `${path}.knockback`),
    pierce,
    bounceCount,
    goreFactor: requireBoundedNumber(record.goreFactor, 0, 1, `${path}.goreFactor`),
    baseAccuracy: requireBoundedNumber(record.baseAccuracy, 0, 1, `${path}.baseAccuracy`),
    weaponClassSkillId,
    weaponTypeSkillId,
  });
  const fingerprint = requireFingerprint(record.fingerprint, `${path}.fingerprint`);
  const expectedFingerprint = computeActiveWeaponSnapshotFingerprint(snapshotWithoutFingerprint);
  if (fingerprint !== expectedFingerprint) {
    fail(
      'fingerprint-mismatch',
      `Snapshot fingerprint ${fingerprint} does not match content fingerprint ${expectedFingerprint}`,
      `${path}.fingerprint`,
    );
  }
  return deepFreeze({ ...snapshotWithoutFingerprint, fingerprint });
}

export function createActiveWeaponSnapshotV1(
  instance:
    | Pick<GeneratedEquipmentInstanceV1, 'instanceId'>
    | { readonly instanceId: GeneratedEquipmentInstanceId },
  weaponDef: WeaponDef,
  overrides?: unknown,
): ActiveWeaponSnapshotV1 {
  const generatedEquipmentInstanceId = requireGeneratedEquipmentInstanceId(
    instance.instanceId,
    '$.activeWeaponSnapshot.instanceId',
  );
  const validatedOverrides = validateActiveWeaponSnapshotOverrides(
    overrides,
    '$.activeWeaponSnapshot.overrides',
  );
  const candidateWithoutFingerprint = deepFreeze({
    schemaVersion: ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
    generatedEquipmentInstanceId,
    ...weaponDef,
    ...validatedOverrides,
    id: weaponDef.id,
    sourceWeaponDefId: weaponDef.id,
    canonicalSkillTags: canonicalActiveWeaponSkillTags(
      (validatedOverrides.weaponClassSkillId as WeaponClassSkillId | undefined) ??
        weaponDef.weaponClassSkillId,
      (validatedOverrides.weaponTypeSkillId as WeaponTypeSkillId | undefined) ??
        weaponDef.weaponTypeSkillId,
    ),
  });
  return validateActiveWeaponSnapshotV1(
    {
      ...candidateWithoutFingerprint,
      fingerprint: computeActiveWeaponSnapshotFingerprint(candidateWithoutFingerprint),
    },
    {
      expectedInstanceId: generatedEquipmentInstanceId,
      expectedSourceWeaponDefId: weaponDef.id,
    },
  );
}

function validateStatBonuses(
  value: unknown,
  path: string,
): Readonly<Partial<Record<StatId, number>>> {
  const record = requireRecord(value, path);
  const bonuses: Partial<Record<StatId, number>> = {};
  for (const [key, bonus] of Object.entries(record)) {
    if (!isValidStatId(key)) {
      fail('invalid-payload', `Unknown stat ${key}`, `${path}.${key}`);
    }
    bonuses[key] = requireFiniteNumber(bonus, `${path}.${key}`);
  }
  return Object.freeze(bonuses);
}

function isActiveWeaponSnapshotCreateInput(
  value: unknown,
): value is ActiveWeaponSnapshotCreateInputV1 {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  // The deferred form is identified by the presence of `weaponDefId` and the
  // strict ABSENCE of `schemaVersion`.  Any versioned object (including a
  // future v2 snapshot) must flow to snapshot validation and be rejected there;
  // only the exact two-field deferred stub { weaponDefId, overrides? } is
  // treated as a create-input here.
  return typeof obj.weaponDefId === 'string' && !('schemaVersion' in obj);
}

function buildSnapshotFromCreateInput(
  value: unknown,
  expectedInstanceId: GeneratedEquipmentInstanceId | undefined,
  path: string,
): ActiveWeaponSnapshotV1 {
  const record = requireRecord(value, path);
  const weaponDefId = requireNonEmptyString(record.weaponDefId, `${path}.weaponDefId`);
  const weaponDef = getWeaponDef(weaponDefId);
  if (!weaponDef) {
    fail('invalid-payload', `Unknown weapon def "${weaponDefId}"`, `${path}.weaponDefId`);
  }
  if (expectedInstanceId === undefined) {
    fail(
      'invalid-payload',
      'Cannot resolve weapon-snapshot create input without an expected instance ID',
      path,
    );
  }
  return createActiveWeaponSnapshotV1(
    { instanceId: expectedInstanceId },
    weaponDef,
    record.overrides,
  );
}

/**
 * Returns a deferred {@link ActiveWeaponSnapshotCreateInputV1} that the
 * registry will expand into a full {@link ActiveWeaponSnapshotV1} (with the
 * correct instance ID and fingerprint) inside
 * {@link createGeneratedEquipmentInstance}.
 *
 * @param weaponDefId   The static weapon-def ID to base the snapshot on.
 * @param overrides     Optional combat-stat overrides applied on top of the
 *                      static weapon def's fields.
 */
export function createActiveWeaponSnapshotInput(
  weaponDefId: string,
  overrides?: ActiveWeaponCombatOverridesV1,
): ActiveWeaponSnapshotCreateInputV1 {
  return Object.freeze({ weaponDefId, ...(overrides !== undefined ? { overrides } : {}) });
}

function validateFrozenFields(
  value: unknown,
  path: string,
  expectedInstanceId?: GeneratedEquipmentInstanceId,
  allowDeferredSnapshot = false,
): FrozenEquipmentFieldsV1 {
  const record = requireRecord(value, path);
  requireKeys(
    record,
    [
      'schemaVersion',
      'displayName',
      'artKey',
      'slots',
      'tags',
      'weightLb',
      'statBonuses',
      'abilityGrants',
      'passiveGrants',
      'activeWeaponSnapshot',
    ],
    path,
  );
  requireVersion(
    record.schemaVersion,
    FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );

  return deepFreeze({
    schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
    displayName: requireNonEmptyString(record.displayName, `${path}.displayName`),
    artKey: requireNonEmptyString(record.artKey, `${path}.artKey`),
    slots: requireSlots(record.slots, `${path}.slots`),
    tags: requireStringArray(record.tags, `${path}.tags`, true),
    weightLb: requireNonNegativeNumber(record.weightLb, `${path}.weightLb`),
    statBonuses: validateStatBonuses(record.statBonuses, `${path}.statBonuses`),
    abilityGrants: requireStringArray(record.abilityGrants, `${path}.abilityGrants`, true),
    passiveGrants: requireStringArray(record.passiveGrants, `${path}.passiveGrants`, true),
    activeWeaponSnapshot: (() => {
      if (record.activeWeaponSnapshot === null) return null;
      if (allowDeferredSnapshot && isActiveWeaponSnapshotCreateInput(record.activeWeaponSnapshot)) {
        return buildSnapshotFromCreateInput(
          record.activeWeaponSnapshot,
          expectedInstanceId,
          `${path}.activeWeaponSnapshot`,
        );
      }
      return validateActiveWeaponSnapshotV1(record.activeWeaponSnapshot, {
        expectedInstanceId,
      });
    })(),
  });
}

function validateEffects(
  value: unknown,
  rarity: GeneratedEquipmentRarity,
  policy: GeneratedEquipmentGenerationPolicyV1,
  path: string,
): readonly ResolvedEquipmentEffectV1[] {
  if (!Array.isArray(value)) {
    fail('invalid-payload', 'Expected an array', path);
  }

  const effects: ResolvedEquipmentEffectV1[] = [];
  const effectIds = new Set<string>();
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const effectPath = `${path}[${index}]`;
    const record = requireRecord(value[index], effectPath);
    requireVersion(
      record.schemaVersion,
      GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
      `${effectPath}.schemaVersion`,
    );
    const effectId = requireNonEmptyString(record.effectId, `${effectPath}.effectId`);
    if (effectIds.has(effectId)) {
      fail('invalid-payload', `Duplicate effect ${effectId}`, `${effectPath}.effectId`);
    }
    effectIds.add(effectId);
    const effectOrdinal = requireInteger(record.effectOrdinal, 0, `${effectPath}.effectOrdinal`);
    if (effectOrdinal !== index) {
      fail('invalid-payload', `Expected effect ordinal ${index}`, `${effectPath}.effectOrdinal`);
    }
    const unitCost = requireInteger(record.unitCost, 1, `${effectPath}.unitCost`);
    if (unitCost !== 1 && unitCost !== 2) {
      fail('invalid-payload', 'Effect unit cost must be 1 or 2', `${effectPath}.unitCost`);
    }
    units += unitCost;

    if (record.kind === 'stat') {
      requireKeys(
        record,
        [
          'schemaVersion',
          'effectId',
          'effectOrdinal',
          'unitCost',
          'kind',
          'stat',
          'operation',
          'value',
        ],
        effectPath,
      );
      const stat = requireNonEmptyString(record.stat, `${effectPath}.stat`);
      if (!isValidStatId(stat)) {
        fail('invalid-payload', `Unknown stat ${stat}`, `${effectPath}.stat`);
      }
      if (record.operation !== 'add' && record.operation !== 'multiply') {
        fail('invalid-payload', 'Expected add or multiply', `${effectPath}.operation`);
      }
      effects.push(
        deepFreeze({
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId,
          effectOrdinal,
          unitCost,
          kind: 'stat',
          stat,
          operation: record.operation,
          value: requireFiniteNumber(record.value, `${effectPath}.value`),
        }),
      );
      continue;
    }

    if (record.kind === 'abilityGrant' || record.kind === 'passiveGrant') {
      requireKeys(
        record,
        ['schemaVersion', 'effectId', 'effectOrdinal', 'unitCost', 'kind', 'grantId'],
        effectPath,
      );
      effects.push(
        deepFreeze({
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId,
          effectOrdinal,
          unitCost,
          kind: record.kind,
          grantId: requireNonEmptyString(record.grantId, `${effectPath}.grantId`),
        }),
      );
      continue;
    }

    fail('invalid-payload', `Unknown effect kind ${String(record.kind)}`, `${effectPath}.kind`);
  }

  const requiredUnits = policy.rarityEffectUnits[rarity];
  if (units !== requiredUnits) {
    fail(
      'invalid-payload',
      `Rarity ${rarity} requires exactly ${requiredUnits} effect units; received ${units}`,
      path,
    );
  }
  return Object.freeze(effects);
}

function requireArraysEqual(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail(
      'invalid-payload',
      `Frozen grants must exactly match resolvedEffects grants; expected [${expected.join(
        ', ',
      )}] but received [${actual.join(', ')}]`,
      path,
    );
  }
}

/**
 * Enforces that the consumer-facing `frozen.abilityGrants` / `frozen.passiveGrants`
 * arrays agree exactly (same ids, same order) with the `abilityGrant` /
 * `passiveGrant` entries in `resolvedEffects`. Because different consumers read
 * different authorities (equip gating reads `frozen.*Grants`; ability granting
 * reads `resolvedEffects`), the two representations must be a single source of
 * truth or a registry-valid instance could advertise grants it never applies at
 * runtime (or vice versa).
 */
function validateGrantEquivalence(
  effects: readonly ResolvedEquipmentEffectV1[],
  frozen: FrozenEquipmentFieldsV1,
  path: string,
): void {
  const effectAbilityGrants = effects.flatMap((effect) =>
    'kind' in effect && effect.kind === 'abilityGrant' ? [effect.grantId] : [],
  );
  const effectPassiveGrants = effects.flatMap((effect) =>
    'kind' in effect && effect.kind === 'passiveGrant' ? [effect.grantId] : [],
  );
  requireArraysEqual(frozen.abilityGrants, effectAbilityGrants, `${path}.frozen.abilityGrants`);
  requireArraysEqual(frozen.passiveGrants, effectPassiveGrants, `${path}.frozen.passiveGrants`);
}

export function validateGeneratedEquipmentGenerationPolicyV1(
  value: unknown,
): GeneratedEquipmentGenerationPolicyV1 {
  const path = '$.generationPolicy';
  const record = requireRecord(value, path);
  requireKeys(
    record,
    [
      'schemaVersion',
      'generationVersion',
      'rarityInherentScalars',
      'rarityEffectUnits',
      'enhancementPercentPerLevel',
      'maximumEnhancementLevel',
      'normalizationMode',
      'drawOrder',
    ],
    path,
  );
  requireVersion(
    record.schemaVersion,
    GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );
  requireVersion(
    record.generationVersion,
    GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
    `${path}.generationVersion`,
  );

  const scalarRecord = requireRecord(record.rarityInherentScalars, `${path}.rarityInherentScalars`);
  requireKeys(scalarRecord, ['common', 'uncommon', 'rare'], `${path}.rarityInherentScalars`);
  const unitRecord = requireRecord(record.rarityEffectUnits, `${path}.rarityEffectUnits`);
  requireKeys(unitRecord, ['common', 'uncommon', 'rare'], `${path}.rarityEffectUnits`);

  const commonUnits = requireInteger(unitRecord.common, 0, `${path}.rarityEffectUnits.common`);
  const uncommonUnits = requireInteger(
    unitRecord.uncommon,
    0,
    `${path}.rarityEffectUnits.uncommon`,
  );
  const rareUnits = requireInteger(unitRecord.rare, 0, `${path}.rarityEffectUnits.rare`);
  if (commonUnits > 2 || uncommonUnits > 2 || rareUnits > 2) {
    fail(
      'invalid-payload',
      'Rarity effect-unit budgets must be in [0, 2]',
      `${path}.rarityEffectUnits`,
    );
  }

  const maximumEnhancementLevel = requireEnhancement(
    record.maximumEnhancementLevel,
    5,
    `${path}.maximumEnhancementLevel`,
  );

  return deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION,
    generationVersion: GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
    rarityInherentScalars: {
      common: requireNonNegativeNumber(scalarRecord.common, `${path}.rarityInherentScalars.common`),
      uncommon: requireNonNegativeNumber(
        scalarRecord.uncommon,
        `${path}.rarityInherentScalars.uncommon`,
      ),
      rare: requireNonNegativeNumber(scalarRecord.rare, `${path}.rarityInherentScalars.rare`),
    },
    rarityEffectUnits: {
      common: commonUnits as 0 | 1 | 2,
      uncommon: uncommonUnits as 0 | 1 | 2,
      rare: rareUnits as 0 | 1 | 2,
    },
    enhancementPercentPerLevel: requireNonNegativeNumber(
      record.enhancementPercentPerLevel,
      `${path}.enhancementPercentPerLevel`,
    ),
    maximumEnhancementLevel,
    normalizationMode: requireNonEmptyString(record.normalizationMode, `${path}.normalizationMode`),
    drawOrder: requireStringArray(record.drawOrder, `${path}.drawOrder`, false),
  });
}

export function computeEquipmentFingerprint(value: unknown): EquipmentFingerprintV1 {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function computeActiveWeaponSnapshotFingerprint(
  snapshot: Omit<ActiveWeaponSnapshotV1, 'fingerprint'>,
): EquipmentFingerprintV1 {
  return computeEquipmentFingerprint(snapshot);
}

export function computeGenerationPolicyFingerprint(
  policy: GeneratedEquipmentGenerationPolicyV1,
): EquipmentFingerprintV1 {
  return computeEquipmentFingerprint(validateGeneratedEquipmentGenerationPolicyV1(policy));
}

export function generatedEquipmentInstanceKey(
  runKeyValue: string,
  ordinalValue: number,
): GeneratedEquipmentInstanceId {
  const runKey = requireRunKey(runKeyValue, '$.runKey');
  const ordinal = requireInteger(ordinalValue, 0, '$.ordinal');
  if (!Number.isSafeInteger(ordinal)) {
    fail('invalid-payload', 'Expected a safe integer >= 0', '$.ordinal');
  }
  return `gei:v1:${runKey}:${ordinal}`;
}

function validateActiveWeaponSnapshotOverrides(value: unknown, path: string): Partial<WeaponDef> {
  if (value === undefined) {
    return {};
  }
  const record = requireRecord(value, path);
  for (const key of Object.keys(record)) {
    if (!ACTIVE_WEAPON_SNAPSHOT_OVERRIDE_KEYS.has(key as keyof WeaponDef)) {
      fail(
        'illegal-override',
        `Illegal active-weapon snapshot override key ${key}`,
        `${path}.${key}`,
      );
    }
  }
  return record;
}

function validateGeneration(
  value: unknown,
  path: string,
  options: InstanceValidationOptions,
): GeneratedEquipmentGenerationV1 {
  const record = requireRecord(value, path);
  requireKeys(record, ['schemaVersion', 'runKey', 'ordinal', 'generationPolicyFingerprint'], path);
  requireVersion(
    record.schemaVersion,
    GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );
  const runKey = requireRunKey(record.runKey, `${path}.runKey`);
  if (options.expectedRunKey !== undefined && runKey !== options.expectedRunKey) {
    fail(
      'run-key-mismatch',
      `Run key ${runKey} does not match registry run key ${options.expectedRunKey}`,
      `${path}.runKey`,
    );
  }
  const generationPolicyFingerprint = requireFingerprint(
    record.generationPolicyFingerprint,
    `${path}.generationPolicyFingerprint`,
  );
  if (
    options.expectedPolicyFingerprint !== undefined &&
    generationPolicyFingerprint !== options.expectedPolicyFingerprint
  ) {
    fail(
      'tuning-drift',
      'Generation policy fingerprint does not match the configured registry policy',
      `${path}.generationPolicyFingerprint`,
    );
  }

  return deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
    runKey,
    ordinal: requireInteger(record.ordinal, 0, `${path}.ordinal`),
    generationPolicyFingerprint,
  });
}

function fingerprintContent(
  instance: Omit<GeneratedEquipmentInstanceV1, 'fingerprint'>,
): EquipmentFingerprintV1 {
  return computeEquipmentFingerprint(instance);
}

export function validateGeneratedEquipmentInstanceV1(
  value: unknown,
  options: InstanceValidationOptions = {},
): GeneratedEquipmentInstanceV1 {
  const path = '$.instance';
  const record = requireRecord(value, path);
  requireKeys(
    record,
    [
      'schemaVersion',
      'instanceId',
      'contentRevision',
      'baseId',
      'itemLevel',
      'rarity',
      'enhancementLevel',
      'resolvedEffects',
      'frozen',
      'generation',
      'fingerprint',
    ],
    path,
  );
  requireVersion(
    record.schemaVersion,
    GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );

  const policy =
    options.expectedPolicy === undefined
      ? DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1
      : validateGeneratedEquipmentGenerationPolicyV1(options.expectedPolicy);
  const generation = validateGeneration(record.generation, `${path}.generation`, options);
  const expectedInstanceId = generatedEquipmentInstanceKey(generation.runKey, generation.ordinal);
  if (record.instanceId !== expectedInstanceId) {
    fail(
      'invalid-payload',
      `Instance ID must match generated key ${expectedInstanceId}`,
      `${path}.instanceId`,
    );
  }
  const rarity = requireRarity(record.rarity, `${path}.rarity`);
  const enhancementLevel = requireEnhancement(
    record.enhancementLevel,
    policy.maximumEnhancementLevel,
    `${path}.enhancementLevel`,
  );
  const instanceWithoutFingerprint = deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
    instanceId: expectedInstanceId,
    contentRevision: requireInteger(record.contentRevision, 0, `${path}.contentRevision`),
    baseId: requireNonEmptyString(record.baseId, `${path}.baseId`),
    itemLevel: requireInteger(record.itemLevel, 1, `${path}.itemLevel`),
    rarity,
    enhancementLevel,
    resolvedEffects: validateEffects(
      record.resolvedEffects,
      rarity,
      policy,
      `${path}.resolvedEffects`,
    ),
    frozen: validateFrozenFields(record.frozen, `${path}.frozen`, expectedInstanceId),
    generation,
  });
  validateGrantEquivalence(
    instanceWithoutFingerprint.resolvedEffects,
    instanceWithoutFingerprint.frozen,
    path,
  );
  const fingerprint = requireFingerprint(record.fingerprint, `${path}.fingerprint`);
  const expectedFingerprint = fingerprintContent(instanceWithoutFingerprint);
  if (fingerprint !== expectedFingerprint) {
    fail(
      'fingerprint-mismatch',
      `Fingerprint ${fingerprint} does not match content fingerprint ${expectedFingerprint}`,
      `${path}.fingerprint`,
    );
  }
  return deepFreeze({ ...instanceWithoutFingerprint, fingerprint });
}

function validateCreateInput(
  value: unknown,
  policy: GeneratedEquipmentGenerationPolicyV1,
  expectedInstanceId: GeneratedEquipmentInstanceId,
): {
  readonly baseId: string;
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: GeneratedEquipmentEnhancementLevel;
  readonly resolvedEffects: readonly ResolvedEquipmentEffectV1[];
  readonly frozen: FrozenEquipmentFieldsV1;
} {
  const path = '$.createInput';
  const record = requireRecord(value, path);
  requireKeys(
    record,
    ['baseId', 'itemLevel', 'rarity', 'enhancementLevel', 'resolvedEffects', 'frozen'],
    path,
  );
  const rarity = requireRarity(record.rarity, `${path}.rarity`);
  return deepFreeze({
    baseId: requireNonEmptyString(record.baseId, `${path}.baseId`),
    itemLevel: requireInteger(record.itemLevel, 1, `${path}.itemLevel`),
    rarity,
    enhancementLevel: requireEnhancement(
      record.enhancementLevel,
      policy.maximumEnhancementLevel,
      `${path}.enhancementLevel`,
    ),
    resolvedEffects: validateEffects(
      record.resolvedEffects,
      rarity,
      policy,
      `${path}.resolvedEffects`,
    ),
    frozen: validateFrozenFields(record.frozen, `${path}.frozen`, expectedInstanceId, true),
  });
}

function getRegistryState(registry: GeneratedEquipmentRegistry): RegistryState {
  const state = registryStates.get(registry);
  if (!state) {
    fail(
      'invalid-payload',
      'Registry was not created by createGeneratedEquipmentRegistry',
      '$.registry',
    );
  }
  return state;
}

export function createGeneratedEquipmentRegistry(
  options: CreateGeneratedEquipmentRegistryOptions = {},
): GeneratedEquipmentRegistry {
  const generationPolicy = validateGeneratedEquipmentGenerationPolicyV1(
    options.generationPolicy ?? DEFAULT_GENERATED_EQUIPMENT_GENERATION_POLICY_V1,
  );
  const registry: GeneratedEquipmentRegistry = Object.freeze({
    runKey:
      options.runKey === undefined ? null : requireRunKey(options.runKey, '$.registry.runKey'),
    generationPolicy,
    generationPolicyFingerprint: computeGenerationPolicyFingerprint(generationPolicy),
  });
  registryStates.set(registry, { instances: new Map(), nextOrdinal: 0 });
  return registry;
}

function requireConfiguredRunKey(registry: GeneratedEquipmentRegistry): string {
  if (registry.runKey === null) {
    fail(
      'registry-unconfigured',
      'Generated equipment registry requires an explicit immutable run key',
      '$.registry.runKey',
    );
  }
  return registry.runKey;
}

export interface GeneratedEquipmentRegistryTransaction {
  /**
   * Scratch registry that shares the live run key / generation policy /
   * fingerprint but is backed by an isolated CLONE of the live instance map.
   * Generate against this; the live registry stays untouched until `commit()`.
   */
  readonly registry: GeneratedEquipmentRegistry;
  /**
   * Atomically publish the scratch state to the live registry. This is a single
   * synchronous `WeakMap.set` that cannot throw, so a caller may mutate sibling
   * world state immediately after in the same no-throw region for true
   * all-or-nothing semantics. Throws (`invalid-payload`) if called twice.
   */
  commit(): void;
}

/**
 * Begin an all-or-nothing generation transaction against the world's live
 * generated-equipment registry.
 *
 * The returned `registry` is a distinct frozen object that shares the live
 * registry's immutable identity (run key, generation policy + fingerprint) but
 * is backed by a CLONE of the live instance map and `nextOrdinal`. Generate any
 * number of instances against it — ordinals continue contiguously from the live
 * count, preserving the contiguous-ordinal invariant that save/restore depends
 * on. If any step throws, discard the transaction: the live registry is never
 * mutated. On success, `commit()` swaps the live registry's backing state to the
 * scratch state.
 *
 * Not safe against interleaved generation on the LIVE registry between creation
 * and commit; the deterministic single-threaded sim never interleaves, which is
 * why no locking is needed.
 */
export function createGeneratedEquipmentRegistryTransaction(
  world: GeneratedEquipmentRegistryWorld,
): GeneratedEquipmentRegistryTransaction {
  const liveRegistry = world.generatedEquipmentRegistry;
  const liveState = getRegistryState(liveRegistry);
  requireConfiguredRunKey(liveRegistry);
  const scratchRegistry: GeneratedEquipmentRegistry = Object.freeze({
    runKey: liveRegistry.runKey,
    generationPolicy: liveRegistry.generationPolicy,
    generationPolicyFingerprint: liveRegistry.generationPolicyFingerprint,
  });
  const scratchState: RegistryState = {
    instances: new Map(liveState.instances),
    nextOrdinal: liveState.nextOrdinal,
  };
  registryStates.set(scratchRegistry, scratchState);
  let committed = false;
  return {
    registry: scratchRegistry,
    commit(): void {
      if (committed) {
        fail(
          'invalid-payload',
          'Generated equipment registry transaction already committed',
          '$.registry.transaction',
        );
      }
      committed = true;
      registryStates.set(liveRegistry, scratchState);
    },
  };
}

export function createGeneratedEquipmentInstance(
  world: GeneratedEquipmentRegistryWorld,
  value: GeneratedEquipmentCreateInputV1,
): GeneratedEquipmentInstanceV1 {
  const registry = world.generatedEquipmentRegistry;
  const state = getRegistryState(registry);
  const runKey = requireConfiguredRunKey(registry);
  const ordinal = state.nextOrdinal;
  const instanceId = generatedEquipmentInstanceKey(runKey, ordinal);
  const input = validateCreateInput(value, registry.generationPolicy, instanceId);
  if (state.instances.has(instanceId)) {
    fail('duplicate-instance', `Instance ${instanceId} already exists`, '$.instance.instanceId');
  }

  const generation: GeneratedEquipmentGenerationV1 = deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION,
    runKey,
    ordinal,
    generationPolicyFingerprint: registry.generationPolicyFingerprint,
  });
  const content = deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION,
    instanceId,
    contentRevision: 0,
    baseId: input.baseId,
    itemLevel: input.itemLevel,
    rarity: input.rarity,
    enhancementLevel: input.enhancementLevel,
    resolvedEffects: input.resolvedEffects,
    frozen: input.frozen,
    generation,
  });
  const instance = validateGeneratedEquipmentInstanceV1(
    { ...content, fingerprint: fingerprintContent(content) },
    {
      expectedRunKey: runKey,
      expectedPolicy: registry.generationPolicy,
      expectedPolicyFingerprint: registry.generationPolicyFingerprint,
    },
  );

  state.instances.set(instance.instanceId, instance);
  state.nextOrdinal += 1;
  return instance;
}

export function registerGeneratedEquipmentInstance(
  world: GeneratedEquipmentRegistryWorld,
  value: unknown,
): GeneratedEquipmentInstanceV1 {
  const registry = world.generatedEquipmentRegistry;
  const state = getRegistryState(registry);
  const runKey = requireConfiguredRunKey(registry);
  const instance = validateGeneratedEquipmentInstanceV1(value, {
    expectedRunKey: runKey,
    expectedPolicy: registry.generationPolicy,
    expectedPolicyFingerprint: registry.generationPolicyFingerprint,
  });
  if (state.instances.has(instance.instanceId)) {
    fail(
      'duplicate-instance',
      `Instance ${instance.instanceId} already exists`,
      '$.instance.instanceId',
    );
  }
  const generation = instance.generation;
  if (!generation) {
    fail(
      'invalid-payload',
      'Generated equipment instance is missing generation metadata',
      '$.instance.generation',
    );
  }
  if (generation.ordinal !== state.nextOrdinal) {
    fail(
      'ordinal-gap',
      `Expected ordinal ${state.nextOrdinal}; received ${generation.ordinal}`,
      '$.instance.generation.ordinal',
    );
  }

  state.instances.set(instance.instanceId, instance);
  state.nextOrdinal += 1;
  return instance;
}

export function hasGeneratedEquipmentInstance(
  world: GeneratedEquipmentRegistryWorld,
  instanceId: GeneratedEquipmentInstanceId,
): boolean {
  return getRegistryState(world.generatedEquipmentRegistry).instances.has(instanceId);
}

export function getGeneratedEquipmentInstance(
  world: GeneratedEquipmentRegistryWorld,
  instanceId: GeneratedEquipmentInstanceId,
): GeneratedEquipmentInstanceV1 | undefined {
  return getRegistryState(world.generatedEquipmentRegistry).instances.get(instanceId);
}

export function requireGeneratedEquipmentInstance(
  world: GeneratedEquipmentRegistryWorld,
  instanceId: GeneratedEquipmentInstanceId,
): GeneratedEquipmentInstanceV1 {
  const instance = getGeneratedEquipmentInstance(world, instanceId);
  if (!instance) {
    fail('not-found', `Generated equipment instance ${instanceId} was not found`, '$.instanceId');
  }
  return instance;
}

export function requireGeneratedEquipmentActiveWeaponSnapshot(
  world: GeneratedEquipmentRegistryWorld,
  instanceId: GeneratedEquipmentInstanceId,
): ActiveWeaponSnapshotV1 {
  const instance = requireGeneratedEquipmentInstance(world, instanceId);
  const snapshot = instance.frozen.activeWeaponSnapshot;
  if (!snapshot) {
    fail(
      'invalid-payload',
      `Generated equipment instance ${instanceId} has no active weapon snapshot`,
      '$.instance.frozen.activeWeaponSnapshot',
    );
  }
  return validateActiveWeaponSnapshotV1(snapshot, {
    expectedInstanceId: instanceId,
    expectedSourceWeaponDefId: snapshot.sourceWeaponDefId,
  });
}

export function listGeneratedEquipmentInstances(
  world: GeneratedEquipmentRegistryWorld,
): readonly GeneratedEquipmentInstanceV1[] {
  return Object.freeze([...getRegistryState(world.generatedEquipmentRegistry).instances.values()]);
}

export function snapshotGeneratedEquipmentRegistry(
  world: GeneratedEquipmentRegistryWorld,
): GeneratedEquipmentRegistrySnapshotV1 {
  const registry = world.generatedEquipmentRegistry;
  const state = getRegistryState(registry);
  const runKey = requireConfiguredRunKey(registry);
  return deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION,
    runKey,
    generationPolicy: registry.generationPolicy,
    generationPolicyFingerprint: registry.generationPolicyFingerprint,
    nextOrdinal: state.nextOrdinal,
    instances: [...state.instances.values()],
  });
}

function validateSnapshotEnvelope(
  value: unknown,
  registry: GeneratedEquipmentRegistry,
): {
  readonly runKey: string;
  readonly nextOrdinal: number;
  readonly rawInstances: readonly unknown[];
} {
  const path = '$.snapshot';
  const record = requireRecord(value, path);
  requireKeys(
    record,
    [
      'schemaVersion',
      'runKey',
      'generationPolicy',
      'generationPolicyFingerprint',
      'nextOrdinal',
      'instances',
    ],
    path,
  );
  requireVersion(
    record.schemaVersion,
    GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );
  const runKey = requireRunKey(record.runKey, `${path}.runKey`);
  const expectedRunKey = requireConfiguredRunKey(registry);
  if (runKey !== expectedRunKey) {
    fail(
      'run-key-mismatch',
      `Snapshot run key ${runKey} does not match registry run key ${expectedRunKey}`,
      `${path}.runKey`,
    );
  }
  const policy = validateGeneratedEquipmentGenerationPolicyV1(record.generationPolicy);
  const policyFingerprint = requireFingerprint(
    record.generationPolicyFingerprint,
    `${path}.generationPolicyFingerprint`,
  );
  const computedFingerprint = computeGenerationPolicyFingerprint(policy);
  if (policyFingerprint !== computedFingerprint) {
    fail(
      'fingerprint-mismatch',
      'Snapshot generation policy fingerprint does not match its policy content',
      `${path}.generationPolicyFingerprint`,
    );
  }
  if (policyFingerprint !== registry.generationPolicyFingerprint) {
    fail(
      'tuning-drift',
      'Snapshot generation policy does not match the configured registry policy',
      `${path}.generationPolicyFingerprint`,
    );
  }
  if (!Array.isArray(record.instances)) {
    fail('invalid-payload', 'Expected an array', `${path}.instances`);
  }
  return {
    runKey,
    nextOrdinal: requireInteger(record.nextOrdinal, 0, `${path}.nextOrdinal`),
    rawInstances: record.instances,
  };
}

export function restoreGeneratedEquipmentRegistry(
  world: GeneratedEquipmentRegistryWorld,
  value: unknown,
  options: { readonly allowSparseOrdinals?: boolean } = {},
): void {
  const registry = world.generatedEquipmentRegistry;
  const state = getRegistryState(registry);
  if (state.instances.size !== 0 || state.nextOrdinal !== 0) {
    fail('registry-not-empty', 'Registry restore requires an empty registry', '$.registry');
  }

  const snapshot = validateSnapshotEnvelope(value, registry);
  const restored = new Map<GeneratedEquipmentInstanceId, GeneratedEquipmentInstanceV1>();
  let largestOrdinal = -1;
  for (let index = 0; index < snapshot.rawInstances.length; index += 1) {
    const instance = validateGeneratedEquipmentInstanceV1(snapshot.rawInstances[index], {
      expectedRunKey: snapshot.runKey,
      expectedPolicy: registry.generationPolicy,
      expectedPolicyFingerprint: registry.generationPolicyFingerprint,
    });
    const generation = instance.generation;
    if (!generation) {
      fail(
        'invalid-payload',
        'Generated equipment instance is missing generation metadata',
        `$.snapshot.instances[${index}].generation`,
      );
    }
    if (
      generation.ordinal >= snapshot.nextOrdinal ||
      (!options.allowSparseOrdinals && generation.ordinal !== index)
    ) {
      fail(
        'ordinal-gap',
        options.allowSparseOrdinals
          ? `Generated ordinal ${generation.ordinal} must be below nextOrdinal ${snapshot.nextOrdinal}`
          : `Expected ordinal ${index}; received ${generation.ordinal}`,
        `$.snapshot.instances[${index}].generation.ordinal`,
      );
    }
    if (restored.has(instance.instanceId)) {
      fail(
        'duplicate-instance',
        `Duplicate instance ${instance.instanceId}`,
        `$.snapshot.instances[${index}].instanceId`,
      );
    }
    largestOrdinal = Math.max(largestOrdinal, generation.ordinal);
    restored.set(instance.instanceId, instance);
  }
  if (
    (!options.allowSparseOrdinals && snapshot.nextOrdinal !== restored.size) ||
    (options.allowSparseOrdinals && snapshot.nextOrdinal < largestOrdinal + 1)
  ) {
    fail(
      'ordinal-gap',
      options.allowSparseOrdinals
        ? `Snapshot nextOrdinal ${snapshot.nextOrdinal} must exceed largest instance ordinal ${largestOrdinal}`
        : `Snapshot nextOrdinal ${snapshot.nextOrdinal} does not match contiguous instance count ${restored.size}`,
      '$.snapshot.nextOrdinal',
    );
  }

  for (const [instanceId, instance] of restored) {
    state.instances.set(instanceId, instance);
  }
  state.nextOrdinal = snapshot.nextOrdinal;
}
