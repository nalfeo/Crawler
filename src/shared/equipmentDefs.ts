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
 *
 * It also radiates a faint restorative warmth: a slow heal-over-time
 * (`hpRegen`) status effect, our first live consumer of the status-effect
 * framework. The `sourceId` here is a placeholder — `equip()` overrides it with
 * the equipped instance's id so duplicate items track independently.
 */
export const MERCHANTS_CHARM_DEF: EquipmentItemDef = {
  id: SHOPKEEPER_EQUIPMENT_ITEM_ID,
  name: "Merchant's Magic Charm",
  slots: ['neck'],
  statBonuses: { charisma: 1 },
  rarity: 'uncommon',
  grantsStatusEffects: [
    {
      stat: 'hpRegen',
      op: 'add',
      value: 0.75,
      durationMs: null,
      sourceType: 'equipment',
      sourceId: 'merchants-charm',
      stackRule: { mode: 'replace' },
    },
  ],
};

/** Cost (in gold) of the merchant's charm. */
export const MERCHANTS_CHARM_COST = 15;

/** itemId → equipment definition for items that can be worn. */
const EQUIPMENT_BY_ITEM_ID: ReadonlyMap<string, EquipmentItemDef> = new Map([
  [MERCHANTS_CHARM_DEF.id, MERCHANTS_CHARM_DEF],
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
