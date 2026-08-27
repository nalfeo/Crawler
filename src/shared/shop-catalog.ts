/**
 * Shared merchant-stock catalog resolution.
 *
 * Merchant stock lists (Floor 2 shop archetypes) reference either an inventory
 * item slug from `items.ts` or a raw weapon id from `weaponDefs.ts`. Purchasing
 * has to turn that reference into the item slug that actually lands in the
 * player's bag, and that slug is only worth selling when an equipment def in
 * `equipmentDefs.ts` makes it equippable.
 *
 * Both the stock-list loader (`data/shop-archetypes.ts`, which rejects
 * unstockable ids at load time) and the authoritative purchase path
 * (`core/settlement-shop-purchase.ts`) resolve through here, so a merchant can
 * never advertise something the purchase path then refuses as `unknown-item`,
 * nor sell a weapon the player could never wield.
 */

import { getEquipmentDefForItem, getEquipmentDefForWeaponId } from './equipmentDefs.js';
import { getItemById } from './items.js';

/** The bag item a merchant offer resolves to. */
export interface ShopCatalogItem {
  /** Inventory item slug added to the bag on purchase. */
  readonly itemId: string;
  /** Player-facing name for the resolved item. */
  readonly displayName: string;
}

/**
 * Resolve a merchant stock id onto the bag item it grants, or `null` when the
 * id is not something the player could buy *and use*.
 *
 * Weapon ids are resolved first, through the equipment def that activates
 * them. The resolved slug is deliberately allowed to differ from the weapon id
 * — stocking `'sword'` grants the `'iron-sword'` bag item, exactly as the Floor
 * 1 merchant already does — and taking this branch first means a later same-id
 * catalog entry can never shadow the alias. The display name comes from the
 * same resolved def, so the advertised name always describes the item the
 * player actually receives.
 *
 * A **weapon-tagged catalog item** additionally has to carry an equipment def
 * of its own. Without one, `isEquippableItem` is false, the inventory panel
 * offers no equip action, and `equipmentSystem` never activates a `WeaponDef` —
 * so the sale would take gold and hand back an inert bag entry. Non-weapon
 * catalog items (consumables, the merchant's charm) have no such requirement.
 */
export function resolveShopCatalogItem(itemId: string): ShopCatalogItem | null {
  const weaponEquipment = getEquipmentDefForWeaponId(itemId);
  if (weaponEquipment) {
    return { itemId: weaponEquipment.id, displayName: weaponEquipment.name };
  }
  const catalogItem = getItemById(itemId);
  if (!catalogItem) {
    return null;
  }
  if (
    catalogItem.tags.includes('Weapons') &&
    getEquipmentDefForItem(catalogItem.id) === undefined
  ) {
    return null;
  }
  return { itemId: catalogItem.id, displayName: catalogItem.name };
}

/** True when a merchant may stock this id (i.e. it can actually be bought). */
export function isShopCatalogItem(itemId: string): boolean {
  return resolveShopCatalogItem(itemId) !== null;
}
