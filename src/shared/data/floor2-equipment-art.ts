import type { SpriteType } from '../sprite-types.js';

const FLOOR2_WEAPON_FAMILIES = [
  'blade',
  'axe',
  'bludgeon',
  'polearm',
  'bow',
  'firearm',
  'thrown',
  'magic-focus',
  'beam',
  'trap',
  // Classic Fantasy [Basic Leather] theme-equipment-forge roster (6 weapons).
  // A dedicated 11th family rather than folding into an existing 5-slot family
  // so the pre-existing 10 families keep their validated 5-per-family shape;
  // see EXPECTED_WEAPON_FAMILY_COUNTS below for this family's 6-member count.
  'basic-leather',
] as const;

type Floor2WeaponFamily = (typeof FLOOR2_WEAPON_FAMILIES)[number];
export type Floor2EquipmentCategory = 'weapon' | 'armor' | 'accessory';
export type Floor2EquipmentSlot = 'weapon' | 'head' | 'torso' | 'hands' | 'feet' | 'accessory';
export type Floor2NonWeaponFamily =
  | 'headgear'
  | 'body-armor'
  | 'handwear'
  | 'footwear'
  | 'accessory';
export type Floor2EquipmentFamily = Floor2WeaponFamily | Floor2NonWeaponFamily;

const FLOOR2_EQUIPMENT_STABLE_IDS = [
  'weapon.iron-cleaver',
  'weapon.ashwood-bow',
  'weapon.quarterstaff',
  'weapon.throwing-knives',
  'weapon.war-pick',
  'weapon.hand-crossbow',
  'weapon.bone-saw',
  'weapon.chain-flail',
  'weapon.dueling-saber',
  'weapon.stone-maul',
  'weapon.musketeer-rifle',
  'weapon.ember-wand',
  'weapon.frost-crook',
  'weapon.storm-sling',
  'weapon.venom-dirk',
  'weapon.sun-hammer',
  'weapon.moon-scythe',
  'weapon.blood-lance',
  'weapon.grave-shovel',
  'weapon.butcher-hook',
  'weapon.cog-pistol',
  'weapon.alchemist-sprayer',
  'weapon.rune-axe',
  'weapon.tower-spear',
  'weapon.twin-katar',
  'weapon.thorn-whip',
  'weapon.crystal-cannon',
  'weapon.baseball-bat',
  'weapon.rivet-gun',
  'weapon.sawblade-launcher',
  'weapon.oil-lantern',
  'weapon.shock-baton',
  'weapon.boarding-axe',
  'weapon.hunting-bola',
  'weapon.spike-shield',
  'weapon.war-fan',
  'weapon.crescent-glaive',
  'weapon.siege-bow',
  'weapon.powder-keg',
  'weapon.acid-flask',
  'weapon.ice-pick',
  'weapon.flame-tongs',
  'weapon.ritual-dagger',
  'weapon.brass-knuckles',
  'weapon.meteor-hammer',
  'weapon.harpoon-gun',
  'weapon.plague-censer',
  'weapon.bone-chakram',
  'weapon.echo-bell',
  'weapon.void-rapier',
  'head.quartermaster-cap',
  'head.batfolk-hood',
  'head.alchemist-goggles',
  'torso.chain-hauberk',
  'torso.velvet-coat',
  'torso.scavenger-harness',
  'torso.runed-cuirass',
  'hands.duelist-gloves',
  'hands.thorn-gauntlets',
  'hands.tinker-grips',
  'feet.iron-greaves',
  'feet.shadow-boots',
  'feet.merchant-sandals',
  'accessory.compass-charm',
  'accessory.lucky-feather',
  'accessory.gearwork-locket',
  'accessory.warding-bell',
  'accessory.surveyor-map',
  // Classic Fantasy [Basic Leather] theme-equipment-forge roster — see
  // data/theme-equipment-sets/classic-fantasy-basic-leather.json (source of
  // truth for slugs/slots) and floor2-basic-leather-bases.ts (catalog defs).
  'weapon.iron-dagger',
  'weapon.iron-shortsword',
  'weapon.wooden-bow',
  'weapon.iron-spear',
  'weapon.iron-handaxe',
  'weapon.wooden-club',
  'head.leather-cap',
  'accessory.leather-collar',
  'torso.leather-tunic',
  'hands.leather-gloves',
  'feet.leather-pants',
  'feet.leather-boots',
  'accessory.iron-ring',
] as const;

export type Floor2EquipmentStableId = (typeof FLOOR2_EQUIPMENT_STABLE_IDS)[number];
export type Floor2WeaponStableId = Extract<Floor2EquipmentStableId, `weapon.${string}`>;
export type Floor2EquipmentRuntimeKey = `equipment/${string}/${string}`;

const WEAPON_IDS_BY_FAMILY: Readonly<Record<Floor2WeaponFamily, readonly Floor2WeaponStableId[]>> =
  {
    blade: [
      'weapon.iron-cleaver',
      'weapon.bone-saw',
      'weapon.dueling-saber',
      'weapon.venom-dirk',
      'weapon.void-rapier',
    ],
    axe: [
      'weapon.war-pick',
      'weapon.butcher-hook',
      'weapon.rune-axe',
      'weapon.boarding-axe',
      'weapon.ice-pick',
    ],
    bludgeon: [
      'weapon.chain-flail',
      'weapon.stone-maul',
      'weapon.sun-hammer',
      'weapon.baseball-bat',
      'weapon.brass-knuckles',
    ],
    polearm: [
      'weapon.quarterstaff',
      'weapon.blood-lance',
      'weapon.grave-shovel',
      'weapon.tower-spear',
      'weapon.crescent-glaive',
    ],
    bow: [
      'weapon.ashwood-bow',
      'weapon.hand-crossbow',
      'weapon.storm-sling',
      'weapon.hunting-bola',
      'weapon.siege-bow',
    ],
    firearm: [
      'weapon.musketeer-rifle',
      'weapon.cog-pistol',
      'weapon.crystal-cannon',
      'weapon.rivet-gun',
      'weapon.harpoon-gun',
    ],
    thrown: [
      'weapon.throwing-knives',
      'weapon.twin-katar',
      'weapon.war-fan',
      'weapon.acid-flask',
      'weapon.bone-chakram',
    ],
    'magic-focus': [
      'weapon.ember-wand',
      'weapon.frost-crook',
      'weapon.moon-scythe',
      'weapon.ritual-dagger',
      'weapon.plague-censer',
    ],
    beam: [
      'weapon.alchemist-sprayer',
      'weapon.thorn-whip',
      'weapon.shock-baton',
      'weapon.flame-tongs',
      'weapon.echo-bell',
    ],
    trap: [
      'weapon.sawblade-launcher',
      'weapon.oil-lantern',
      'weapon.spike-shield',
      'weapon.powder-keg',
      'weapon.meteor-hammer',
    ],
    'basic-leather': [
      'weapon.iron-dagger',
      'weapon.iron-shortsword',
      'weapon.wooden-bow',
      'weapon.iron-spear',
      'weapon.iron-handaxe',
      'weapon.wooden-club',
    ],
  };

interface NonWeaponGroup {
  readonly slot: Exclude<Floor2EquipmentSlot, 'weapon'>;
  readonly category: Exclude<Floor2EquipmentCategory, 'weapon'>;
  readonly family: Floor2NonWeaponFamily;
  readonly ids: readonly Floor2EquipmentStableId[];
}

const NON_WEAPON_GROUPS: readonly NonWeaponGroup[] = [
  {
    slot: 'head',
    category: 'armor',
    family: 'headgear',
    ids: [
      'head.quartermaster-cap',
      'head.batfolk-hood',
      'head.alchemist-goggles',
      'head.leather-cap',
    ],
  },
  {
    slot: 'torso',
    category: 'armor',
    family: 'body-armor',
    ids: [
      'torso.chain-hauberk',
      'torso.velvet-coat',
      'torso.scavenger-harness',
      'torso.runed-cuirass',
      'torso.leather-tunic',
    ],
  },
  {
    slot: 'hands',
    category: 'armor',
    family: 'handwear',
    ids: [
      'hands.duelist-gloves',
      'hands.thorn-gauntlets',
      'hands.tinker-grips',
      'hands.leather-gloves',
    ],
  },
  {
    slot: 'feet',
    category: 'armor',
    family: 'footwear',
    ids: [
      'feet.iron-greaves',
      'feet.shadow-boots',
      'feet.merchant-sandals',
      'feet.leather-pants',
      'feet.leather-boots',
    ],
  },
  {
    slot: 'accessory',
    category: 'accessory',
    family: 'accessory',
    ids: [
      'accessory.compass-charm',
      'accessory.lucky-feather',
      'accessory.gearwork-locket',
      'accessory.warding-bell',
      'accessory.surveyor-map',
      'accessory.leather-collar',
      'accessory.iron-ring',
    ],
  },
];

export interface Floor2EquipmentBriefInput {
  readonly type: SpriteType;
  readonly name: string;
  readonly description: string;
}

export interface Floor2EquipmentArtDefinition {
  readonly ordinal: number;
  readonly stableId: Floor2EquipmentStableId;
  readonly runtimeKey: Floor2EquipmentRuntimeKey;
  readonly category: Floor2EquipmentCategory;
  readonly family: Floor2EquipmentFamily;
  readonly slot: Floor2EquipmentSlot;
  readonly spriteType: SpriteType;
  readonly compositionId: Floor2EquipmentFamily;
  readonly placeholderAssetPath: string;
  readonly productionWaveId: string;
  readonly briefInput: Floor2EquipmentBriefInput;
}

export interface Floor2EquipmentProductionWave {
  readonly id: string;
  readonly kind: 'weapon-family' | 'ui-slot';
  readonly family: Floor2EquipmentFamily;
  readonly slot: Floor2EquipmentSlot;
  readonly entries: readonly Floor2EquipmentArtDefinition[];
}

function runtimeKeyForFloor2Equipment(
  stableId: Floor2EquipmentStableId,
): Floor2EquipmentRuntimeKey {
  const separator = stableId.indexOf('.');
  if (separator <= 0 || separator === stableId.length - 1) {
    throw new Error(`Invalid Floor 2 equipment stable ID: ${stableId}`);
  }
  return `equipment/${stableId.slice(0, separator)}/${stableId.slice(separator + 1)}`;
}

function displayNameFor(stableId: Floor2EquipmentStableId): string {
  const slug = stableId.slice(stableId.indexOf('.') + 1);
  return slug.replace(/(^|-)([a-z])/g, (_match, separator: string, letter: string) => {
    return `${separator === '-' ? ' ' : ''}${letter.toUpperCase()}`;
  });
}

function buildDefinitions(): readonly Floor2EquipmentArtDefinition[] {
  const classification = new Map<
    Floor2EquipmentStableId,
    Pick<Floor2EquipmentArtDefinition, 'category' | 'family' | 'slot' | 'spriteType'>
  >();

  for (const family of FLOOR2_WEAPON_FAMILIES) {
    for (const stableId of WEAPON_IDS_BY_FAMILY[family]) {
      classification.set(stableId, {
        category: 'weapon',
        family,
        slot: 'weapon',
        spriteType: 'weapon',
      });
    }
  }
  for (const group of NON_WEAPON_GROUPS) {
    for (const stableId of group.ids) {
      classification.set(stableId, {
        category: group.category,
        family: group.family,
        slot: group.slot,
        spriteType: 'item',
      });
    }
  }

  return FLOOR2_EQUIPMENT_STABLE_IDS.map((stableId, index) => {
    const metadata = classification.get(stableId);
    if (!metadata) {
      throw new Error(`Missing Floor 2 equipment art classification: ${stableId}`);
    }
    const runtimeKey = runtimeKeyForFloor2Equipment(stableId);
    const productionWaveId =
      metadata.category === 'weapon'
        ? `floor2-equipment-weapon-${metadata.family}`
        : `floor2-equipment-ui-${metadata.slot}`;
    const name = displayNameFor(stableId);
    return Object.freeze({
      ordinal: index + 1,
      stableId,
      runtimeKey,
      ...metadata,
      compositionId: metadata.family,
      placeholderAssetPath: `generated/${runtimeKey}-placeholder.png`,
      productionWaveId,
      briefInput: Object.freeze({
        type: metadata.spriteType,
        name,
        description:
          `${name} Floor 2 equipment icon for stable runtime key ${runtimeKey}. ` +
          `Create one centered, silhouette-readable ${metadata.family} ${metadata.category} ` +
          'on a transparent background; preserve the runtime key exactly.',
      }),
    });
  });
}

function validateDefinitions(definitions: readonly Floor2EquipmentArtDefinition[]): void {
  if (definitions.length !== 81) {
    throw new Error(
      `Expected 81 Floor 2 equipment art definitions, received ${definitions.length}`,
    );
  }
  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) {
      throw new Error(`Duplicate Floor 2 equipment ${label}`);
    }
  };
  unique(
    definitions.map((entry) => entry.stableId),
    'stable ID',
  );
  unique(
    definitions.map((entry) => entry.runtimeKey),
    'runtime key',
  );
  unique(
    definitions.map((entry) => entry.placeholderAssetPath),
    'placeholder path',
  );
  const weapons = definitions.filter((entry) => entry.category === 'weapon');
  if (weapons.length !== 56 || definitions.length - weapons.length !== 25) {
    throw new Error(
      'Floor 2 equipment art definitions must contain exactly 56 weapons and 25 others',
    );
  }
  // Every legacy (Wave A + Wave B) family stays fixed at 5 bases; the Classic
  // Fantasy [Basic Leather] roster is a dedicated 11th family with 6 bases so
  // it does not have to dilute (or be diluted by) the thematic families.
  const expectedWeaponFamilyCounts: Readonly<Record<Floor2WeaponFamily, number>> = {
    blade: 5,
    axe: 5,
    bludgeon: 5,
    polearm: 5,
    bow: 5,
    firearm: 5,
    thrown: 5,
    'magic-focus': 5,
    beam: 5,
    trap: 5,
    'basic-leather': 6,
  };
  for (const family of FLOOR2_WEAPON_FAMILIES) {
    const count = weapons.filter((entry) => entry.family === family).length;
    const expected = expectedWeaponFamilyCounts[family];
    if (count !== expected) {
      throw new Error(
        `Floor 2 weapon family ${family} must contain exactly ${expected} bases; received ${count}`,
      );
    }
  }
}

export const FLOOR2_EQUIPMENT_ART_DEFINITIONS = buildDefinitions();
validateDefinitions(FLOOR2_EQUIPMENT_ART_DEFINITIONS);

function buildProductionWaves(): readonly Floor2EquipmentProductionWave[] {
  const waves = new Map<string, Floor2EquipmentProductionWave>();
  for (const entry of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
    const existing = waves.get(entry.productionWaveId);
    if (existing) {
      (existing.entries as Floor2EquipmentArtDefinition[]).push(entry);
      continue;
    }
    waves.set(entry.productionWaveId, {
      id: entry.productionWaveId,
      kind: entry.category === 'weapon' ? 'weapon-family' : 'ui-slot',
      family: entry.family,
      slot: entry.slot,
      entries: [entry],
    });
  }
  return Array.from(waves.values(), (wave) =>
    Object.freeze({ ...wave, entries: Object.freeze([...wave.entries]) }),
  );
}

export const FLOOR2_EQUIPMENT_PRODUCTION_WAVES = buildProductionWaves();
