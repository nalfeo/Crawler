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
