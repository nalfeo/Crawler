/**
 * Shared merchant-stock catalog resolution.
 *
 * Merchant stock lists (Floor 2 shop archetypes) reference either an inventory
 * item slug from `items.ts` or a raw weapon id from `weaponDefs.ts`. Purchasing
 * has to turn that reference into the item slug that actually lands in the
 * player's bag, and a weapon id only does so when a weapon-equipment def in
 * `equipmentDefs.ts` activates it.
 *
 * Both the stock-list loader (`data/shop-archetypes.ts`, which rejects
 * unstockable ids at load time) and the authoritative purchase path
 * (`core/settlement-shop-purchase.ts`) resolve through here, so a merchant can
 * never advertise something the purchase path then refuses as `unknown-item`.
 */

import { getEquipmentDefForWeaponId } from './equipmentDefs.js';
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
 * id is neither a catalog item nor an equippable weapon.
 *
 * A weapon id resolves to the *equipment def's* item slug, which is
 * deliberately allowed to differ from the weapon id — stocking `'sword'` grants
 * the `'iron-sword'` bag item, exactly as the Floor 1 merchant already does.
 * The display name comes from the same resolved def, so the advertised name
 * always describes the item the player actually receives.
 */
export function resolveShopCatalogItem(itemId: string): ShopCatalogItem | null {
  const catalogItem = getItemById(itemId);
  if (catalogItem) {
    return { itemId: catalogItem.id, displayName: catalogItem.name };
  }
  const equipmentDef = getEquipmentDefForWeaponId(itemId);
  if (equipmentDef) {
    return { itemId: equipmentDef.id, displayName: equipmentDef.name };
  }
  return null;
}

/** True when a merchant may stock this id (i.e. it can actually be bought). */
export function isShopCatalogItem(itemId: string): boolean {
  return resolveShopCatalogItem(itemId) !== null;
}
