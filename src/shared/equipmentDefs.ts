/**
 * Purchasable / quest-reward equipment definitions.
 *
 * Bridges the inventory item catalog (`items.ts`, keyed by item slug) to the
 * equipment system (`EquipmentItemDef`). An inventory item is "equippable" when
 * it has an entry here. This lets the equipment UI/unlock logic ask a single
 * question: "does the player hold something equippable?".
 *
 * Weapon-typed equipment (`weaponId !== undefined`) additionally activates the
 * corresponding `WeaponDef` from `weaponDefs.ts` when equipped — that's what
 * makes a Sword item in your bag actually swing when it lands in the
 * `mainHand` slot. Handedness is encoded via `slots`: `['mainHand']` for
 * one-handed, `['mainHand', 'offHand']` for two-handed weapons (which
 * occupy both hand slots and forbid an off-hand item).
 */

import type { EquipmentItemDef } from './equipment-types.js';
import { SHOPKEEPER_EQUIPMENT_ITEM_ID } from './quest-types.js';
import { getWeaponDef } from './weaponDefs.js';

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

// ---------------------------------------------------------------------------
// Weapon equipment defs
// ---------------------------------------------------------------------------

/**
 * A weapon-equipment def: an EquipmentItemDef whose `weaponId` links it back
 * to a `WeaponDef` in `weaponDefs.ts`. Handedness is encoded via `slots`:
 * one-handed weapons list only `mainHand`; two-handed weapons list both
 * hand slots so the equipment system atomically reserves them.
 *
 * `id` matches the corresponding inventory item slug in `items.ts` (so
 * purchased weapons in the bag round-trip cleanly through equip → unequip →
 * bag). All three Floor 1 starter weapons (sword/bow/baseball-bat) re-use the
 * same inventory item slugs the Floor 1 post-quest merchant offers
 * (iron-sword/frost-bow/bone-club), so equipping them from the bag lands in
 * the exact same slots as the starter.
 */
interface WeaponEquipmentDef extends EquipmentItemDef {
  readonly weaponId: string;
}

function weapon(def: WeaponEquipmentDef): WeaponEquipmentDef {
  return def;
}

/**
 * All weapon-equipment defs, keyed by their inventory item slug (the id
 * players see in the bag). Each references a canonical `WeaponDef` from
 * `weaponDefs.ts`. See `STARTER_WEAPON_ID_TO_ITEM_ID` below for the
 * starter → shop-item mapping used at loadout time.
 */
const WEAPON_EQUIPMENT_DEFS: readonly WeaponEquipmentDef[] = [
  // --- Floor 1 starter weapons (each maps to a shop item slug) ---
  weapon({
    id: 'iron-sword',
    name: 'Sword',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'sword',
  }),
  weapon({
    id: 'frost-bow',
    name: 'Bow',
    slots: ['mainHand', 'offHand'],
    statBonuses: {},
    rarity: 'uncommon',
    weaponId: 'bow',
  }),
  weapon({
    id: 'bone-club',
    name: 'Baseball Bat',
    slots: ['mainHand', 'offHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'baseball-bat',
  }),
  weapon({
    id: 'plasma-pistol',
    name: 'Pistol',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'rare',
    weaponId: 'pistol',
  }),
  weapon({
    id: 'rusty-shiv',
    name: 'Rusty Shiv',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'throwing-knife',
  }),
  weapon({
    id: 'crystal-wand',
    name: 'Flare Gun',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'uncommon',
    weaponId: 'fireball',
  }),
];

/**
 * Starter weapon id (from `WEAPON_DEFS`) → inventory item slug used by the
 * Floor 1 shop. Exported so `floorScenario.ts` (post-quest merchant stock)
 * consumes the same table the equipment loadout consumes — a single source
 * of truth. The invariant is validated at module load below.
 */
export const STARTER_WEAPON_ID_TO_ITEM_ID: ReadonlyMap<string, string> = new Map([
  ['sword', 'iron-sword'],
  ['bow', 'frost-bow'],
  ['baseball-bat', 'bone-club'],
  ['pistol', 'plasma-pistol'],
  ['throwing-knife', 'rusty-shiv'],
  ['fireball', 'crystal-wand'],
]);

/** itemId → equipment definition for items that can be worn. */
const EQUIPMENT_BY_ITEM_ID: ReadonlyMap<string, EquipmentItemDef> = (() => {
  const map = new Map<string, EquipmentItemDef>();
  map.set(MERCHANTS_CHARM_DEF.id, MERCHANTS_CHARM_DEF);
  for (const def of WEAPON_EQUIPMENT_DEFS) {
    if (map.has(def.id)) {
      throw new Error(`Duplicate equipment def id: ${def.id}`);
    }
    // Every weapon-equipment def must reference a real WeaponDef so equipping
    // it can activate combat behavior. A typo here would ship a "weapon" that
    // takes up a hand slot without actually letting the player attack — fail
    // loudly at boot instead.
    if (getWeaponDef(def.weaponId) === undefined) {
      throw new Error(
        `Weapon equipment def ${def.id} references unknown WeaponDef: ${def.weaponId}`,
      );
    }
    map.set(def.id, def);
  }
  // Validate the starter-weapon mapping resolves to real weapon-equipment defs
  // AND to real WeaponDefs. A silent divergence here would ship a starter
  // weapon that can't be equipped.
  for (const [weaponId, itemId] of STARTER_WEAPON_ID_TO_ITEM_ID) {
    if (!map.has(itemId)) {
      throw new Error(`Starter weapon mapping references unknown equipment def: ${itemId}`);
    }
    if (getWeaponDef(weaponId) === undefined) {
      throw new Error(`Starter weapon mapping references unknown WeaponDef: ${weaponId}`);
    }
  }
  return map;
})();

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

/**
 * Equipment def for a starter weapon id (e.g. `'sword'`, `'bow'`) — the id
 * players see in the loadout picker. Returns undefined for weapons that
 * aren't in the Floor 1 starter pool. Used by `selectFloor1StarterWeapon` to
 * route the loadout choice through the equipment system so the starter lives
 * in the `mainHand` (or both hand slots, for two-handers) from frame one.
 */
export function getEquipmentDefForStarterWeapon(weaponId: string): EquipmentItemDef | undefined {
  const itemId = STARTER_WEAPON_ID_TO_ITEM_ID.get(weaponId);
  if (itemId === undefined) return undefined;
  return EQUIPMENT_BY_ITEM_ID.get(itemId);
}
