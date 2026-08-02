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
import {
  FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
  FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
} from './data/floor2-equipment-wave-b.js';
import { getItemById } from './items.js';
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
  weightLb: 0.25,
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
    weightLb: 3,
  }),
  weapon({
    id: 'frost-bow',
    name: 'Bow',
    slots: ['mainHand', 'offHand'],
    statBonuses: {},
    rarity: 'uncommon',
    weaponId: 'bow',
    weightLb: 5,
  }),
  weapon({
    id: 'bone-club',
    name: 'Baseball Bat',
    slots: ['mainHand', 'offHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'baseball-bat',
    weightLb: 6,
  }),
  weapon({
    id: 'plasma-pistol',
    name: 'Pistol',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'rare',
    weaponId: 'pistol',
    weightLb: 2,
  }),
  weapon({
    id: 'throwing-knife',
    name: 'Throwing Knife',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'throwing-knife',
    weightLb: 0.5,
  }),
  weapon({
    id: 'fireball',
    name: 'Fire Wand',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'uncommon',
    weaponId: 'fireball',
    weightLb: 1,
  }),
  weapon({
    id: 'laser',
    name: 'Laser',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'rare',
    weaponId: 'laser',
    weightLb: 2,
  }),
  weapon({
    id: 'punch',
    name: 'Punch',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'common',
    weaponId: 'punch',
    weightLb: 0.5,
  }),
  weapon({
    id: 'landmine',
    name: 'Landmine',
    slots: ['mainHand'],
    statBonuses: {},
    rarity: 'uncommon',
    weaponId: 'landmine',
    weightLb: 3,
  }),
  // --- Floor 2 weapons ---
  ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS,
];

// ---------------------------------------------------------------------------
// Wearable gear equipment defs (non-weapon armor / accessories)
// ---------------------------------------------------------------------------

/**
 * Placeholder wearable gear covering every non-weapon, non-neck body slot so
 * the paper-doll is fully fillable and the equip-from-inventory flow is
 * testable across all 18 slots. Each `id` matches a `gear(...)` item slug in
 * `items.ts`. Primary-stat bonuses are integers (the equipment validator
 * rejects fractional primaries); secondary stats (armor, moveSpeed, crit,
 * etc.) may be fractional. Rings are split into two distinct items because a
 * def's `slots` are occupied together (AND semantics), so a single ring can
 * fill only one ring slot.
 */
const GEAR_EQUIPMENT_DEFS: readonly EquipmentItemDef[] = [
  {
    id: 'iron-helm',
    name: 'Iron Helm',
    slots: ['head'],
    statBonuses: { armor: 2, constitution: 1 },
    rarity: 'common',
    weightLb: 5,
  },
  {
    id: 'iron-visor',
    name: 'Iron Visor',
    slots: ['face'],
    statBonuses: { armor: 1, critChance: 0.03 },
    rarity: 'common',
    weightLb: 2,
  },
  {
    id: 'steel-pauldrons',
    name: 'Steel Pauldrons',
    slots: ['shoulders'],
    statBonuses: { armor: 2, strength: 1 },
    rarity: 'uncommon',
    weightLb: 6,
  },
  {
    id: 'iron-breastplate',
    name: 'Iron Breastplate',
    slots: ['chest'],
    statBonuses: { armor: 4, constitution: 1 },
    rarity: 'uncommon',
    weightLb: 15,
  },
  {
    id: 'travelers-cloak',
    name: "Traveler's Cloak",
    slots: ['back'],
    statBonuses: { moveSpeed: 0.05, dodgeChance: 0.03 },
    rarity: 'uncommon',
    weightLb: 2,
  },
  {
    id: 'sturdy-belt',
    name: 'Sturdy Belt',
    slots: ['belt'],
    statBonuses: { hpRegen: 0.5, constitution: 1 },
    rarity: 'common',
    weightLb: 1,
  },
  {
    id: 'iron-greaves',
    name: 'Iron Greaves',
    slots: ['legs'],
    statBonuses: { armor: 3, dexterity: 1 },
    rarity: 'uncommon',
    weightLb: 8,
  },
  {
    id: 'leather-boots',
    name: 'Leather Boots',
    slots: ['feet'],
    statBonuses: { moveSpeed: 0.06, armor: 1 },
    rarity: 'common',
    weightLb: 2,
  },
  {
    id: 'leather-gloves',
    name: 'Leather Gloves',
    slots: ['gloves'],
    statBonuses: { attackSpeed: 0.05, dexterity: 1 },
    rarity: 'common',
    weightLb: 1,
  },
  {
    id: 'bronze-vambrace',
    name: 'Bronze Vambrace',
    slots: ['leftArm'],
    statBonuses: { armor: 1, strength: 1 },
    rarity: 'common',
    weightLb: 2,
  },
  {
    id: 'iron-armguard',
    name: 'Iron Armguard',
    slots: ['rightArm'],
    statBonuses: { armor: 1, damageBonus: 2 },
    rarity: 'common',
    weightLb: 2,
  },
  {
    id: 'leather-bracer',
    name: 'Leather Bracer',
    slots: ['leftWrist'],
    statBonuses: { dexterity: 1, dodgeChance: 0.02 },
    rarity: 'common',
    weightLb: 0.5,
  },
  {
    id: 'beaded-bracelet',
    name: 'Beaded Bracelet',
    slots: ['rightWrist'],
    statBonuses: { critChance: 0.02, luck: 1 },
    rarity: 'uncommon',
    weightLb: 0.25,
  },
  {
    id: 'band-of-fortune',
    name: 'Band of Fortune',
    slots: ['ringLeft'],
    statBonuses: { luck: 1, xpBonus: 0.05 },
    rarity: 'rare',
    weightLb: 0.25,
  },
  {
    id: 'signet-of-focus',
    name: 'Signet of Focus',
    slots: ['ringRight'],
    statBonuses: { intelligence: 1, cooldownReduction: 0.03 },
    rarity: 'rare',
    weightLb: 0.25,
  },
  ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS,
];

/**
 * Item slugs of every placeholder wearable gear def, in slot-registry-ish
 * order. Weapons and the charm are intentionally excluded (weapons occupy hand
 * slots the paper-doll fills separately).
 */
export const GEAR_ITEM_IDS: readonly string[] = GEAR_EQUIPMENT_DEFS.filter(
  (definition) => !definition.tags?.includes('wave-b'),
).map((definition) => definition.id);

/**
 * Canonical generated-stock bases for the Floor 2 Quartermaster. Generated
 * weapons and Rare bases stay out until their runtime equip contracts land.
 */
export const FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS: readonly string[] = Object.freeze(
  GEAR_EQUIPMENT_DEFS.filter((def) => def.rarity === 'common' || def.rarity === 'uncommon').map(
    (def) => def.id,
  ),
);

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
  ['throwing-knife', 'throwing-knife'],
  ['fireball', 'fireball'],
  ['laser', 'laser'],
  ['punch', 'punch'],
  ['landmine', 'landmine'],
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
  // Non-weapon wearable gear (armor / accessories). Same dup-id guard; no
  // WeaponDef linkage to validate.
  for (const def of GEAR_EQUIPMENT_DEFS) {
    if (map.has(def.id)) {
      throw new Error(`Duplicate equipment def id: ${def.id}`);
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

/**
 * Test-only overlay for {@link getEquipmentDefForItem}. Lets unit tests register
 * ad-hoc equipment defs (e.g. requirement-gated items, which the shipped catalog
 * has none of) so requirement/swap edge cases are exercisable through the
 * registry-backed `equipFromBag` / `previewEquipDelta` seams without shipping
 * fake catalog items. Never populated in production. Mirrors the repo's existing
 * `_resetCorpseStepTrackingForTest` test-seam convention.
 */
const TEST_EQUIPMENT_OVERRIDES = new Map<string, EquipmentItemDef>();

/** Test-only: register an ad-hoc equipment def resolvable by its item id. */
export function _registerEquipmentDefForTest(def: EquipmentItemDef): void {
  TEST_EQUIPMENT_OVERRIDES.set(def.id, def);
}

/** Test-only: clear every ad-hoc equipment def registered via the test overlay. */
export function _clearEquipmentDefsForTest(): void {
  TEST_EQUIPMENT_OVERRIDES.clear();
}

/** Equipment definition for an inventory item slug, or undefined if not equippable. */
export function getEquipmentDefForItem(itemId: string): EquipmentItemDef | undefined {
  return TEST_EQUIPMENT_OVERRIDES.get(itemId) ?? EQUIPMENT_BY_ITEM_ID.get(itemId);
}

/** True when the given inventory item slug maps to a piece of equipment. */
export function isEquippableItem(itemId: string): boolean {
  return EQUIPMENT_BY_ITEM_ID.has(itemId);
}

/** All registered equipment base IDs, including generated-only bases. */
export function getEquippableItemIds(): string[] {
  return [...EQUIPMENT_BY_ITEM_ID.keys()];
}

/** Equipment IDs that can be inserted through the static inventory item catalog. */
export function getCatalogEquippableItemIds(): string[] {
  return getEquippableItemIds().filter((itemId) => getItemById(itemId) !== undefined);
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
