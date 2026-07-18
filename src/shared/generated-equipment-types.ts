import type { MeleeStyleValue, WeaponTypeValue } from './constants.js';
import type { EquipmentSlotId } from './equipment-slots.js';
import type { StatId } from './stats.js';
import type { WeaponClassSkillId, WeaponTypeSkillId } from './weapon-skills.js';

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

export type ResolvedEquipmentEffectV1 =
  | ResolvedEquipmentStatEffectV1
  | ResolvedEquipmentGrantEffectV1;

export interface ActiveWeaponSnapshotV1 {
  readonly schemaVersion: typeof ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION;
  readonly sourceWeaponDefId: string;
  readonly name: string;
  readonly weaponType: WeaponTypeValue;
  readonly baseDamage: number;
  readonly cooldownMs: number;
  readonly range: number;
  readonly projectileSpeed: number;
  readonly aoeRadius: number;
  readonly durationMs: number;
  readonly beamTickMs: number;
  readonly beamLength: number;
  readonly trapArmMs: number;
  readonly trapTriggerRadius: number;
  readonly trapExplosionRadius: number;
  readonly returnSpeed: number;
  readonly maxRange: number;
  readonly swingArcDeg: number;
  readonly meleeStyle: MeleeStyleValue;
  readonly headRadius: number;
  readonly shaftDamageMult: number;
  readonly knockback: number;
  readonly pierce: number;
  readonly bounceCount: number;
  readonly goreFactor: number;
  readonly baseAccuracy: number;
  readonly weaponClassSkillId: WeaponClassSkillId;
  readonly weaponTypeSkillId: WeaponTypeSkillId;
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
  readonly frozen: FrozenEquipmentFieldsV1;
}

export interface GeneratedEquipmentRegistrySnapshotV1 {
  readonly schemaVersion: typeof GENERATED_EQUIPMENT_REGISTRY_SCHEMA_VERSION;
  readonly runKey: string;
  readonly generationPolicy: GeneratedEquipmentGenerationPolicyV1;
  readonly generationPolicyFingerprint: EquipmentFingerprintV1;
  readonly nextOrdinal: number;
  readonly instances: readonly GeneratedEquipmentInstanceV1[];
}
