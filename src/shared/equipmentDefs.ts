/**
 * Purchasable / quest-reward equipment definitions.
 *
 * Bridges the inventory item catalog (`items.ts`, keyed by item slug) to the
 * equipment system (`EquipmentItemDef`). An inventory item is "equippable" when
 * it has an entry here. This lets the equipment UI/unlock logic ask a single
 * question: "does the player hold something equippable?".
 */

import type { EquipmentItemDef } from './equipment-types.js';
import { SHOPKEEPER_EQUIPMENT_ITEM_ID } from './quest-types.js';

/**
 * The magic charm the Floor 1 merchant gives as a quest reward — a necklace
 * (neck slot) granting +1 charisma. Modest, slightly cursed, fully wearable.
 */
export const MERCHANTS_CHARM_DEF: EquipmentItemDef = {
  id: SHOPKEEPER_EQUIPMENT_ITEM_ID,
  name: "Merchant's Magic Charm",
  slots: ['neck'],
  statBonuses: { charisma: 1 },
  rarity: 'uncommon',
};

export const PADDED_HOOD_DEF: EquipmentItemDef = {
  id: 'padded-hood',
  name: 'Padded Hood',
  slots: ['head'],
  statBonuses: { armor: 1 },
  rarity: 'common',
};

export const REINFORCED_VEST_DEF: EquipmentItemDef = {
  id: 'reinforced-vest',
  name: 'Reinforced Vest',
  slots: ['chest'],
  statBonuses: { armor: 2, constitution: 1 },
  rarity: 'uncommon',
};

export const WORK_BOOTS_DEF: EquipmentItemDef = {
  id: 'work-boots',
  name: 'Work Boots',
  slots: ['feet'],
  statBonuses: { armor: 1, moveSpeed: 0.02 },
  rarity: 'common',
};

/** Cost (in gold) of the merchant's charm. */
export const MERCHANTS_CHARM_COST = 15;

/** itemId → equipment definition for items that can be worn. */
const EQUIPMENT_BY_ITEM_ID: ReadonlyMap<string, EquipmentItemDef> = new Map([
  [MERCHANTS_CHARM_DEF.id, MERCHANTS_CHARM_DEF],
  [PADDED_HOOD_DEF.id, PADDED_HOOD_DEF],
  [REINFORCED_VEST_DEF.id, REINFORCED_VEST_DEF],
  [WORK_BOOTS_DEF.id, WORK_BOOTS_DEF],
]);

/** Equipment definition for an inventory item slug, or undefined if not equippable. */
export function getEquipmentDefForItem(itemId: string): EquipmentItemDef | undefined {
  return EQUIPMENT_BY_ITEM_ID.get(itemId);
}

/** True when the given inventory item slug maps to a piece of equipment. */
export function isEquippableItem(itemId: string): boolean {
  return EQUIPMENT_BY_ITEM_ID.has(itemId);
}

/** All inventory item slugs that map to equipment. */
export function getEquippableItemIds(): string[] {
  return [...EQUIPMENT_BY_ITEM_ID.keys()];
}
