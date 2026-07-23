import type { EquipmentSlotId } from './equipment-slots.js';
import type { StatId } from './stats.js';
import type { WeaponClassSkillId, WeaponTypeSkillId } from './weapon-skills.js';
import type { WeaponDef } from './weaponDefs.js';

export const GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION = 'floor2-equipment-instance/v1' as const;
export const GENERATED_EQUIPMENT_BASE_SCHEMA_VERSION = 'floor2-equipment-base/v1' as const;
export const GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION = 'floor2-equipment-effect/v1' as const;
export const FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION = 'floor2-equipment-frozen/v1' as const;
export const ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION = 'active-weapon-snapshot/v1' as const;
export const GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION =
  'floor2-equipment-generation/v1' as const;
export const GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION =
  'floor2-equipment-generation-policy/v1' as const;
export const GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION = 'floor2-equipment-registry/v1' as const;

export type GeneratedEquipmentInstanceId = `gei:v1:${string}:${number}`;
export type GeneratedEquipmentInstanceKey = GeneratedEquipmentInstanceId;
export type EquipmentFingerprintV1 = `sha256:${string}`;
export type GeneratedEquipmentRarity = 'common' | 'uncommon' | 'rare';
export type GeneratedEquipmentEnhancementLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type GeneratedEquipmentEffectUnitCost = 1 | 2;
export type EquipmentGrantSourceId = `equipment:${GeneratedEquipmentInstanceId}:${number}`;
export type ActiveWeaponClassSkillTag = `weapon-class:${WeaponClassSkillId}`;
export type ActiveWeaponTypeSkillTag = `weapon-type:${WeaponTypeSkillId}`;
export type ActiveWeaponSnapshotSkillTag = ActiveWeaponClassSkillTag | ActiveWeaponTypeSkillTag;
export const RARITY_EFFECT_BUDGET: Readonly<Record<GeneratedEquipmentRarity, number>> = {
  common: 0,
  uncommon: 1,
  rare: 2,
} as const;
export const ENHANCEMENT_MIN = 0 as const;
export const ENHANCEMENT_MAX = 5 as const;
export const KNOWN_GENERATED_SCHEMA_VERSION = GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION;

export interface GeneratedEquipmentBaseV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_BASE_SCHEMA_VERSION;
  readonly baseId: string;
  readonly template:
    | { readonly kind: 'equipment'; readonly equipmentDefId: string }
    | { readonly kind: 'weapon'; readonly weaponDefId: string };
  readonly displayName: string;
  readonly artKey: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly tags: readonly string[];
  readonly weightLb: number;
}

interface ResolvedEquipmentEffectBaseV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION;
  readonly effectId: string;
  readonly effectOrdinal: number;
  readonly unitCost: GeneratedEquipmentEffectUnitCost;
}

export interface ResolvedEquipmentStatEffectV1 extends ResolvedEquipmentEffectBaseV1 {
  readonly kind: 'stat';
  readonly stat: StatId;
  readonly operation: 'add' | 'multiply';
  readonly value: number;
}

export interface ResolvedEquipmentGrantEffectV1 extends ResolvedEquipmentEffectBaseV1 {
  readonly kind: 'abilityGrant' | 'passiveGrant';
  readonly grantId: string;
}

export interface LegacyResolvedEquipmentEffectV1 {
  readonly effectId: string;
  readonly magnitude: number;
  readonly units: GeneratedEquipmentEffectUnitCost;
}

export type ResolvedEquipmentEffectV1 =
  | ResolvedEquipmentStatEffectV1
  | ResolvedEquipmentGrantEffectV1
  | LegacyResolvedEquipmentEffectV1;

export interface ActiveWeaponSnapshotV1 extends WeaponDef {
  readonly schemaVersion: typeof ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION;
  readonly generatedEquipmentInstanceId: GeneratedEquipmentInstanceId;
  readonly sourceWeaponDefId: string;
  readonly canonicalSkillTags: readonly [ActiveWeaponClassSkillTag, ActiveWeaponTypeSkillTag];
  readonly fingerprint: EquipmentFingerprintV1;
}

export interface FrozenEquipmentFieldsV1 {
  readonly schemaVersion: typeof FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION;
  readonly displayName: string;
  readonly artKey: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly tags: readonly string[];
  readonly weightLb: number;
  readonly statBonuses: Readonly<Partial<Record<StatId, number>>>;
  readonly abilityGrants: readonly string[];
  readonly passiveGrants: readonly string[];
  readonly activeWeaponSnapshot: ActiveWeaponSnapshotV1 | null;
}

/**
 * Optional combat-stat overrides the generated-equipment generator may apply
 * on top of a weapon def's static fields when building a weapon snapshot.
 * Validated against {@link ACTIVE_WEAPON_SNAPSHOT_OVERRIDE_KEYS} inside the
 * registry before the snapshot is materialised.
 */
export type ActiveWeaponCombatOverridesV1 = Partial<
  Pick<
    WeaponDef,
    | 'name'
    | 'weaponType'
    | 'baseDamage'
    | 'cooldownMs'
    | 'range'
    | 'projectileSpeed'
    | 'aoeRadius'
    | 'durationMs'
    | 'beamTickMs'
    | 'beamLength'
    | 'trapArmMs'
    | 'trapTriggerRadius'
    | 'trapExplosionRadius'
    | 'returnSpeed'
    | 'maxRange'
    | 'swingArcDeg'
    | 'meleeStyle'
    | 'headRadius'
    | 'shaftDamageMult'
    | 'knockback'
    | 'pierce'
    | 'bounceCount'
    | 'goreFactor'
    | 'baseAccuracy'
    | 'weaponClassSkillId'
    | 'weaponTypeSkillId'
  >
>;

/**
 * Deferred form of an active-weapon snapshot used only inside a
 * {@link FrozenEquipmentFieldsCreateInputV1}.  The registry expands this into a
 * full {@link ActiveWeaponSnapshotV1} (with the correct instance ID and
 * fingerprint) when {@link createGeneratedEquipmentInstance} is called.
 */
export interface ActiveWeaponSnapshotCreateInputV1 {
  readonly weaponDefId: string;
  readonly overrides?: ActiveWeaponCombatOverridesV1;
}

/**
 * Input form of {@link FrozenEquipmentFieldsV1} accepted by
 * {@link GeneratedEquipmentCreateInputV1}.  The `activeWeaponSnapshot` field
 * additionally accepts a deferred {@link ActiveWeaponSnapshotCreateInputV1};
 * the registry resolves it to a full snapshot before persisting the instance.
 *
 * {@link FrozenEquipmentFieldsV1} is structurally assignable here, so existing
 * create-input objects that already carry a fully-built snapshot (or `null`)
 * require no changes.
 */
export interface FrozenEquipmentFieldsCreateInputV1 {
  readonly schemaVersion: typeof FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION;
  readonly displayName: string;
  readonly artKey: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly tags: readonly string[];
  readonly weightLb: number;
  readonly statBonuses: Readonly<Partial<Record<StatId, number>>>;
  readonly abilityGrants: readonly string[];
  readonly passiveGrants: readonly string[];
  readonly activeWeaponSnapshot: ActiveWeaponSnapshotV1 | ActiveWeaponSnapshotCreateInputV1 | null;
}

export interface GeneratedEquipmentGenerationPolicyV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_GENERATION_POLICY_SCHEMA_VERSION;
  readonly generationVersion: typeof GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION;
  readonly rarityInherentScalars: Readonly<Record<GeneratedEquipmentRarity, number>>;
  readonly rarityEffectUnits: Readonly<Record<GeneratedEquipmentRarity, 0 | 1 | 2>>;
  readonly enhancementPercentPerLevel: number;
  readonly maximumEnhancementLevel: GeneratedEquipmentEnhancementLevel;
  readonly normalizationMode: string;
  readonly drawOrder: readonly string[];
}

export interface GeneratedEquipmentGenerationV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_GENERATION_SCHEMA_VERSION;
  readonly runKey: string;
  readonly ordinal: number;
  readonly generationPolicyFingerprint: EquipmentFingerprintV1;
}

export interface GeneratedEquipmentInstanceV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_INSTANCE_SCHEMA_VERSION;
  readonly instanceId: GeneratedEquipmentInstanceId;
  readonly contentRevision: number;
  readonly baseId: string;
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: GeneratedEquipmentEnhancementLevel;
  readonly resolvedEffects: readonly ResolvedEquipmentEffectV1[];
  readonly frozen: FrozenEquipmentFieldsV1;
  readonly generation: GeneratedEquipmentGenerationV1;
  readonly fingerprint: EquipmentFingerprintV1;
}

export interface GeneratedEquipmentCreateInputV1 {
  readonly baseId: string;
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: GeneratedEquipmentEnhancementLevel;
  readonly resolvedEffects: readonly ResolvedEquipmentEffectV1[];
  /**
   * Frozen display/stat/slot data for the new instance.  The
   * `activeWeaponSnapshot` field may carry a deferred
   * {@link ActiveWeaponSnapshotCreateInputV1}; the registry resolves it to a
   * full snapshot before persisting.  Objects typed as
   * {@link FrozenEquipmentFieldsV1} are structurally compatible here.
   */
  readonly frozen: FrozenEquipmentFieldsCreateInputV1;
}

export interface GeneratedEquipmentRegistrySnapshotV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION;
  readonly runKey: string;
  readonly generationPolicy: GeneratedEquipmentGenerationPolicyV1;
  readonly generationPolicyFingerprint: EquipmentFingerprintV1;
  readonly nextOrdinal: number;
  readonly instances: readonly GeneratedEquipmentInstanceV1[];
}

const RUN_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const INSTANCE_ID_RE = /^gei:v1:([a-z0-9][a-z0-9._-]{0,127}):([0-9]+)$/;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

export function parseGeneratedEquipmentInstanceId(
  id: string,
): { readonly runKey: string; readonly ordinal: number } | undefined {
  const match = INSTANCE_ID_RE.exec(id);
  if (!match) return undefined;
  const ordinal = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(ordinal) || String(ordinal) !== match[2]) return undefined;
  return {
    runKey: match[1]!,
    ordinal,
  };
}

export function isValidGeneratedInstanceId(id: string): id is GeneratedEquipmentInstanceId {
  return parseGeneratedEquipmentInstanceId(id) !== undefined;
}

export function isKnownGeneratedSchemaVersion(
  version: string,
): version is typeof KNOWN_GENERATED_SCHEMA_VERSION {
  return version === KNOWN_GENERATED_SCHEMA_VERSION;
}

export function isValidFingerprintV1(value: string): value is EquipmentFingerprintV1 {
  return FINGERPRINT_RE.test(value);
}

export const GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION =
  'floor2-equipment-reward-bundle/v1' as const;

export interface GeneratedEquipmentRewardBundleV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_REWARD_BUNDLE_SCHEMA_VERSION;
  readonly achievementId: string;
  readonly instanceKeys: readonly GeneratedEquipmentInstanceKey[];
}

export function makeRunKey(seed: number | string): string {
  const sanitized = String(seed)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  const leadingMinus = sanitized.startsWith('-');
  const tail = sanitized.replace(/^[._-]+/, '');
  const key = `${leadingMinus ? 'neg-' : ''}${tail}`;
  if (tail.length === 0 || !RUN_KEY_RE.test(key)) {
    throw new Error(`makeRunKey: seed "${seed}" does not produce a valid run key`);
  }
  return key;
}

export function generatedEquipmentRunKeyFromSeed(seed: number): string {
  if (!Number.isFinite(seed)) {
    throw new Error(`Generated equipment run seed must be finite: ${seed}`);
  }
  return `run-seed-${String(seed).replace('+', 'p')}`;
}
