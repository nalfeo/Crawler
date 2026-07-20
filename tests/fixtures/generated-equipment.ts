import type { EquipmentSlotId } from '../../src/shared/equipment-slots.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentCreateInputV1,
} from '../../src/shared/generated-equipment-types.js';
import type { GenerateEquipmentInstanceRequest } from '../../src/game/generated-equipment-generator.js';

export const GENERATED_WEAPON_REQUEST = {
  baseId: 'plasma-pistol',
  itemLevel: 3,
  rarity: 'rare',
  enhancementLevel: 2,
} as const satisfies GenerateEquipmentInstanceRequest;

export const GENERATED_ARMOR_REQUEST = {
  baseId: 'iron-breastplate',
  itemLevel: 4,
  rarity: 'rare',
  enhancementLevel: 3,
} as const satisfies GenerateEquipmentInstanceRequest;

export const GENERATED_ACCESSORY_REQUEST = {
  baseId: 'band-of-fortune',
  itemLevel: 2,
  rarity: 'rare',
  enhancementLevel: 0,
} as const satisfies GenerateEquipmentInstanceRequest;

export function generatedEquipmentInput(options?: {
  readonly baseId?: string;
  readonly slots?: readonly EquipmentSlotId[];
  readonly grants?: boolean;
  readonly weapon?: boolean;
}): GeneratedEquipmentCreateInputV1 {
  const grants = options?.grants ?? false;
  return {
    baseId: options?.baseId ?? 'armor.carryover-test',
    itemLevel: 3,
    rarity: grants ? 'rare' : 'common',
    enhancementLevel: 0,
    resolvedEffects: grants
      ? [
          {
            schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
            effectId: 'carryover-magic-missile',
            effectOrdinal: 0,
            unitCost: 1,
            kind: 'abilityGrant',
            grantId: 'magic-missile',
          },
          {
            schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
            effectId: 'carryover-combat-flow',
            effectOrdinal: 1,
            unitCost: 1,
            kind: 'passiveGrant',
            grantId: 'combat-flow',
          },
        ]
      : [],
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: 'Carryover Test Equipment',
      artKey: 'equipment.carryover-test',
      slots: options?.slots ?? ['head'],
      tags: ['equipment', 'carryover-test'],
      weightLb: 4,
      statBonuses: { armor: 3 },
      abilityGrants: grants ? ['magic-missile'] : [],
      passiveGrants: grants ? ['combat-flow'] : [],
      activeWeaponSnapshot: options?.weapon ? { weaponDefId: 'sword' } : null,
    },
  };
}
