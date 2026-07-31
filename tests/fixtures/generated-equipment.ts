import type { EquipmentSlotId } from '../../src/shared/equipment-slots.js';
import { createActiveWeaponSnapshotInput } from '../../src/core/generated-equipment-registry.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  RARITY_EFFECT_BUDGET,
  type GeneratedEquipmentCreateInputV1,
  type GeneratedEquipmentRarity,
  type ResolvedEquipmentEffectV1,
} from '../../src/shared/generated-equipment-types.js';
import type { _GenerateEquipmentInstanceRequest as GenerateEquipmentInstanceRequest } from '../../src/game/generated-equipment-generator.js';

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
  readonly rarity?: GeneratedEquipmentRarity;
}): GeneratedEquipmentCreateInputV1 {
  const grants = options?.grants ?? false;
  const rarity = options?.rarity ?? (grants ? 'rare' : 'common');
  // The registry validator requires effect units to match RARITY_EFFECT_BUDGET
  // exactly (common 0 / uncommon 1 / rare 2). The `grants` path keeps its
  // ability/passive grant effects (2 units == rare); otherwise emit the exact
  // number of minor stat effects the chosen rarity demands.
  const resolvedEffects: readonly ResolvedEquipmentEffectV1[] = grants
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
    : Array.from(
        { length: RARITY_EFFECT_BUDGET[rarity] },
        (_unused, index): ResolvedEquipmentEffectV1 => ({
          schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
          effectId: `carryover-stat-${index}`,
          effectOrdinal: index,
          unitCost: 1,
          kind: 'stat',
          stat: 'armor',
          operation: 'add',
          value: 1,
        }),
      );
  return {
    baseId: options?.baseId ?? 'armor.carryover-test',
    itemLevel: 3,
    rarity,
    enhancementLevel: 0,
    resolvedEffects,
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
      activeWeaponSnapshot: options?.weapon ? createActiveWeaponSnapshotInput('sword') : null,
    },
  };
}
