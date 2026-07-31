/**
 * Classic Fantasy [Basic Leather] theme-equipment-forge roster, adapted as
 * Floor 2 generated-equipment bases.
 *
 * Source of truth for id/displayName/slots:
 * data/theme-equipment-sets/classic-fantasy-basic-leather.json (18 approved
 * art concepts: 6 weapons + 12 equipment). Combat stats reuse the existing
 * per-family Wave B `WEAPON_PROFILES` verbatim (nearest existing weapon
 * profile per weapon type) rather than authoring new balance numbers; armor
 * baselines are conservative Common values sized against the nearest
 * existing Wave A/B item for the same slot.
 *
 * These bases form the 'basic-leather' Floor2WeaponBaseFamily (weapons) and
 * extend the existing headgear/body-armor/handwear/footwear/accessory
 * non-weapon families (see floor2-equipment-art.ts) — they are a distinct
 * *authoring wave*, not a distinct art-manifest family for non-weapons.
 */
import { deepFreeze } from '../canonical-json.js';
import type { EquipmentSlotId } from '../equipment-slots.js';
import type { EquipmentItemDef } from '../equipment-types.js';
import { createWeaponDef } from '../weapon-def-defaults.js';
import type { WeaponDef } from '../weaponDefs.js';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  type Floor2EquipmentRuntimeKey,
  type Floor2EquipmentStableId,
  type Floor2WeaponStableId,
} from './floor2-equipment-art.js';
import { WEAPON_PROFILES } from './floor2-equipment-wave-b.js';
import type { Floor2WeaponBaseDefinition, Floor2WeaponBaseFamily } from './floor2-weapon-bases.js';

const BASIC_LEATHER_FAMILY: Floor2WeaponBaseFamily = 'basic-leather';

function artKeyFor(stableId: Floor2EquipmentStableId): Floor2EquipmentRuntimeKey {
  const separator = stableId.indexOf('.');
  return `equipment/${stableId.slice(0, separator)}/${stableId.slice(separator + 1)}` as Floor2EquipmentRuntimeKey;
}

interface BasicLeatherWeaponInput {
  readonly stableId: Floor2WeaponStableId;
  readonly weaponId: string;
  readonly name: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly weightLb: number;
  /** Wave B combat profile family reused verbatim for this weapon's stats. */
  readonly profile: keyof typeof WEAPON_PROFILES;
}

// Family choice mirrors the roster's `weaponType` -> nearest existing combat
// profile: iron-dagger/iron-shortsword -> blade, wooden-bow -> bow,
// iron-spear -> polearm, iron-handaxe -> axe, wooden-club -> bludgeon.
const WEAPON_INPUTS: readonly BasicLeatherWeaponInput[] = [
  {
    stableId: 'weapon.iron-dagger',
    weaponId: 'iron-dagger',
    name: 'Iron Dagger',
    slots: ['mainHand'],
    weightLb: 1,
    profile: 'blade',
  },
  {
    stableId: 'weapon.iron-shortsword',
    weaponId: 'iron-shortsword',
    name: 'Iron Shortsword',
    slots: ['mainHand'],
    weightLb: 3,
    profile: 'blade',
  },
  {
    stableId: 'weapon.wooden-bow',
    weaponId: 'wooden-bow',
    name: 'Wooden Bow',
    slots: ['mainHand', 'offHand'],
    weightLb: 4,
    profile: 'bow',
  },
  {
    stableId: 'weapon.iron-spear',
    weaponId: 'iron-spear',
    name: 'Iron Spear',
    slots: ['mainHand', 'offHand'],
    weightLb: 7,
    profile: 'polearm',
  },
  {
    stableId: 'weapon.iron-handaxe',
    weaponId: 'iron-handaxe',
    name: 'Iron Handaxe',
    slots: ['mainHand'],
    weightLb: 4,
    profile: 'axe',
  },
  {
    stableId: 'weapon.wooden-club',
    weaponId: 'wooden-club',
    name: 'Wooden Club',
    slots: ['mainHand'],
    weightLb: 5,
    profile: 'bludgeon',
  },
];

function buildWeaponBase(input: BasicLeatherWeaponInput): Floor2WeaponBaseDefinition {
  const weaponDef: WeaponDef = createWeaponDef({
    id: input.weaponId,
    name: input.name,
    ...WEAPON_PROFILES[input.profile],
  });
  return Object.freeze({
    stableId: input.stableId,
    family: BASIC_LEATHER_FAMILY,
    artKey: artKeyFor(input.stableId),
    equipmentDef: Object.freeze({
      id: input.stableId,
      name: input.name,
      slots: input.slots,
      statBonuses: {},
      rarity: 'common',
      tags: [BASIC_LEATHER_FAMILY],
      weaponId: input.weaponId,
      weightLb: input.weightLb,
    }),
    weaponDef,
  });
}

export const FLOOR2_BASIC_LEATHER_WEAPON_BASES: readonly Floor2WeaponBaseDefinition[] = deepFreeze(
  WEAPON_INPUTS.map(buildWeaponBase),
);

interface BasicLeatherNonWeaponInput {
  readonly stableId: Floor2EquipmentStableId;
  readonly name: string;
  readonly slots: readonly EquipmentSlotId[];
  readonly statBonuses: EquipmentItemDef['statBonuses'];
  readonly weightLb: number;
}

// Conservative Common baselines: mostly pure-armor, sized against the
// nearest existing Wave A/B item for the same real game slot. Three items
// (leather-collar, leather-belt, iron-ring) deliberately carry one inherent
// non-armor stat, making them eligible for Uncommon/Rare reward draws while
// preserving identical base stats across every acquisition source.
const NON_WEAPON_INPUTS: readonly BasicLeatherNonWeaponInput[] = [
  {
    stableId: 'head.leather-cap',
    name: 'Leather Cap',
    slots: ['head'],
    statBonuses: { armor: 1 },
    weightLb: 1,
  },
  {
    stableId: 'accessory.leather-collar',
    name: 'Leather Collar',
    slots: ['neck'],
    statBonuses: { armor: 1, charisma: 1 },
    weightLb: 0.5,
  },
  {
    stableId: 'torso.cloth-cloak',
    name: 'Cloth Cloak',
    slots: ['back'],
    statBonuses: { armor: 1 },
    weightLb: 2,
  },
  {
    stableId: 'torso.leather-shoulder-pads',
    name: 'Leather Shoulder Pads',
    slots: ['shoulders'],
    statBonuses: { armor: 2 },
    weightLb: 2,
  },
  {
    stableId: 'hands.leather-arm-wraps',
    name: 'Leather Arm Wraps',
    slots: ['leftArm', 'rightArm'],
    statBonuses: { armor: 1 },
    weightLb: 1,
  },
  {
    stableId: 'hands.leather-bracers',
    name: 'Leather Bracers',
    slots: ['leftWrist', 'rightWrist'],
    statBonuses: { armor: 1 },
    weightLb: 1,
  },
  {
    stableId: 'torso.leather-tunic',
    name: 'Leather Tunic',
    slots: ['chest'],
    statBonuses: { armor: 3 },
    weightLb: 5,
  },
  {
    stableId: 'hands.leather-gloves',
    name: 'Leather Gloves',
    slots: ['gloves'],
    statBonuses: { armor: 1 },
    weightLb: 1,
  },
  {
    stableId: 'accessory.leather-belt',
    name: 'Leather Belt',
    slots: ['belt'],
    statBonuses: { armor: 1, luck: 1 },
    weightLb: 1,
  },
  {
    stableId: 'feet.leather-pants',
    name: 'Leather Pants',
    slots: ['legs'],
    statBonuses: { armor: 3 },
    weightLb: 3,
  },
  {
    stableId: 'feet.leather-boots',
    name: 'Leather Boots',
    slots: ['feet'],
    statBonuses: { armor: 1 },
    weightLb: 2,
  },
  {
    stableId: 'accessory.iron-ring',
    name: 'Iron Ring',
    slots: ['ringLeft', 'ringRight'],
    statBonuses: { luck: 1 },
    weightLb: 0.25,
  },
];

export const FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES: readonly EquipmentItemDef[] = deepFreeze(
  NON_WEAPON_INPUTS.map((input) =>
    Object.freeze({
      id: input.stableId,
      name: input.name,
      artKey: artKeyFor(input.stableId),
      slots: input.slots,
      statBonuses: input.statBonuses,
      rarity: 'common',
      tags: ['floor2', 'basic-leather', 'equipment'],
      weightLb: input.weightLb,
    }),
  ),
);

export const FLOOR2_BASIC_LEATHER_WEAPON_IDS: readonly Floor2WeaponStableId[] = Object.freeze(
  FLOOR2_BASIC_LEATHER_WEAPON_BASES.map((definition) => definition.stableId),
);

export const FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS: readonly Floor2EquipmentStableId[] =
  Object.freeze(NON_WEAPON_INPUTS.map((input) => input.stableId));

export const FLOOR2_BASIC_LEATHER_STABLE_IDS: readonly Floor2EquipmentStableId[] = Object.freeze([
  ...FLOOR2_BASIC_LEATHER_WEAPON_IDS,
  ...FLOOR2_BASIC_LEATHER_NON_WEAPON_IDS,
]);

function validateBasicLeatherBases(): void {
  if (FLOOR2_BASIC_LEATHER_WEAPON_BASES.length !== 6) {
    throw new Error(
      `Floor 2 Basic Leather bases must contain exactly 6 weapons; received ${FLOOR2_BASIC_LEATHER_WEAPON_BASES.length}`,
    );
  }
  if (FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.length !== 12) {
    throw new Error(
      `Floor 2 Basic Leather bases must contain exactly 12 non-weapons; received ${FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.length}`,
    );
  }
  const stableIds = new Set<string>();
  const weaponIds = new Set<string>();
  for (const definition of FLOOR2_BASIC_LEATHER_WEAPON_BASES) {
    if (stableIds.has(definition.stableId)) {
      throw new Error(`Duplicate Floor 2 Basic Leather stable ID: ${definition.stableId}`);
    }
    if (weaponIds.has(definition.weaponDef.id)) {
      throw new Error(`Duplicate Floor 2 Basic Leather weapon ID: ${definition.weaponDef.id}`);
    }
    stableIds.add(definition.stableId);
    weaponIds.add(definition.weaponDef.id);
    const artDefinition = FLOOR2_EQUIPMENT_ART_DEFINITIONS.find(
      (entry) => entry.stableId === definition.stableId,
    );
    if (
      artDefinition?.category !== 'weapon' ||
      artDefinition.family !== definition.family ||
      artDefinition.runtimeKey !== definition.artKey
    ) {
      throw new Error(`Floor 2 Basic Leather weapon mapping drift: ${definition.stableId}`);
    }
    if (
      definition.equipmentDef.id !== definition.stableId ||
      definition.equipmentDef.weaponId !== definition.weaponDef.id ||
      definition.equipmentDef.rarity !== 'common' ||
      Object.keys(definition.equipmentDef.statBonuses).length !== 0
    ) {
      throw new Error(`Invalid Floor 2 Basic Leather weapon base contract: ${definition.stableId}`);
    }
  }
  for (const definition of FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES) {
    if (stableIds.has(definition.id)) {
      throw new Error(`Duplicate Floor 2 Basic Leather stable ID: ${definition.id}`);
    }
    stableIds.add(definition.id);
    const artDefinition = FLOOR2_EQUIPMENT_ART_DEFINITIONS.find(
      (entry) => entry.stableId === definition.id,
    );
    if (artDefinition === undefined || artDefinition.category === 'weapon') {
      throw new Error(`Floor 2 Basic Leather non-weapon mapping drift: ${definition.id}`);
    }
    if (artDefinition.runtimeKey !== definition.artKey) {
      throw new Error(`Floor 2 Basic Leather non-weapon art key drift: ${definition.id}`);
    }
    if (definition.rarity !== 'common') {
      throw new Error(
        `Floor 2 Basic Leather non-weapon base must be common rarity: ${definition.id}`,
      );
    }
  }
}

validateBasicLeatherBases();

const WEAPON_BASE_BY_ID = new Map(
  FLOOR2_BASIC_LEATHER_WEAPON_BASES.map((definition) => [definition.stableId, definition] as const),
);
const NON_WEAPON_BASE_BY_ID = new Map(
  FLOOR2_BASIC_LEATHER_NON_WEAPON_BASES.map((definition) => [definition.id, definition] as const),
);

export function getFloor2BasicLeatherWeaponBase(
  stableId: string,
): Floor2WeaponBaseDefinition | undefined {
  return WEAPON_BASE_BY_ID.get(stableId as Floor2WeaponStableId);
}

export function getFloor2BasicLeatherNonWeaponBase(stableId: string): EquipmentItemDef | undefined {
  return NON_WEAPON_BASE_BY_ID.get(stableId as Floor2EquipmentStableId);
}
