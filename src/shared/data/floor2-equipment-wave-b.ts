import { MeleeStyle, WeaponType } from '../constants.js';
import type { EquipmentSlotId } from '../equipment-slots.js';
import type { EquipmentItemDef, ItemRarity } from '../equipment-types.js';
import type { WeaponDef } from '../weaponDefs.js';
import { WEAPON_DEF_DEFAULTS } from '../weapon-def-defaults.js';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  type Floor2EquipmentArtDefinition,
  type Floor2EquipmentStableId,
  type Floor2WeaponStableId,
} from './floor2-equipment-art.js';

const WAVE_B_WEAPON_COUNT = 25;
const WAVE_B_NON_WEAPON_COUNT = 18;

export const FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS = [
  'weapon.venom-dirk',
  'weapon.moon-scythe',
  'weapon.tower-spear',
  'weapon.crystal-cannon',
  'weapon.baseball-bat',
  'weapon.rivet-gun',
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
] as const satisfies readonly Floor2WeaponStableId[];

export const FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS = [
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
] as const satisfies readonly Floor2EquipmentStableId[];

export const FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS = [
  ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS,
  ...FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS,
] as const;

const WAVE_B_STABLE_ID_SET = new Set<Floor2EquipmentStableId>(FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS);
const MANIFEST_BY_ID: ReadonlyMap<Floor2EquipmentStableId, Floor2EquipmentArtDefinition> = new Map(
  FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) => [entry.stableId, entry]),
);

const WAVE_B_DISPLAY_NAME_OVERRIDES: Readonly<Partial<Record<Floor2EquipmentStableId, string>>> =
  Object.freeze({
    'feet.iron-greaves': 'Iron Legguards',
  });

function waveBDisplayName(stableId: Floor2EquipmentStableId, fallback: string): string {
  return WAVE_B_DISPLAY_NAME_OVERRIDES[stableId] ?? fallback;
}

function manifestEntry(stableId: Floor2EquipmentStableId): Floor2EquipmentArtDefinition {
  const entry = MANIFEST_BY_ID.get(stableId);
  if (!entry) {
    throw new Error(`Missing canonical Floor 2 Wave B manifest entry: ${stableId}`);
  }
  return entry;
}

function validateWavePartition(): void {
  if (
    FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS.length !== WAVE_B_WEAPON_COUNT ||
    FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS.length !== WAVE_B_NON_WEAPON_COUNT
  ) {
    throw new Error('Floor 2 equipment Wave B must contain exactly 25 weapons and 18 non-weapons');
  }
  const canonicalIds = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter((entry) =>
    WAVE_B_STABLE_ID_SET.has(entry.stableId),
  ).map((entry) => entry.stableId);
  if (
    canonicalIds.length !== FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS.length ||
    canonicalIds.some((stableId, index) => stableId !== FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS[index])
  ) {
    throw new Error(
      'Floor 2 equipment Wave B IDs must be the coordinated Wave A complement in manifest order',
    );
  }
}

validateWavePartition();

type CombatProfile = Omit<WeaponDef, 'id' | 'name'>;

function combatProfile(
  partial: Partial<CombatProfile> &
    Pick<
      CombatProfile,
      'weaponType' | 'baseDamage' | 'cooldownMs' | 'weaponClassSkillId' | 'weaponTypeSkillId'
    >,
): CombatProfile {
  return {
    ...WEAPON_DEF_DEFAULTS,
    ...partial,
  };
}

export const WEAPON_PROFILES = {
  blade: combatProfile({
    weaponType: WeaponType.MELEE,
    baseDamage: 18,
    cooldownMs: 650,
    range: 5,
    aoeRadius: 5,
    durationMs: 240,
    swingArcDeg: 90,
    goreFactor: 0.9,
    baseAccuracy: 0.88,
    weaponClassSkillId: 'slashing',
    weaponTypeSkillId: 'sword',
  }),
  axe: combatProfile({
    weaponType: WeaponType.MELEE,
    baseDamage: 22,
    cooldownMs: 850,
    range: 5.5,
    aoeRadius: 5.5,
    durationMs: 300,
    headRadius: 1.4,
    shaftDamageMult: 0.6,
    knockback: 3,
    goreFactor: 0.75,
    baseAccuracy: 0.82,
    weaponClassSkillId: 'slashing',
    weaponTypeSkillId: 'sword',
  }),
  bludgeon: combatProfile({
    weaponType: WeaponType.MELEE,
    baseDamage: 24,
    cooldownMs: 950,
    range: 6,
    aoeRadius: 6,
    durationMs: 320,
    swingArcDeg: 120,
    headRadius: 1.6,
    shaftDamageMult: 0.5,
    knockback: 4,
    goreFactor: 0.15,
    baseAccuracy: 0.84,
    weaponClassSkillId: 'smashing',
    weaponTypeSkillId: 'hammer',
  }),
  polearm: combatProfile({
    weaponType: WeaponType.MELEE,
    baseDamage: 20,
    cooldownMs: 800,
    range: 7,
    aoeRadius: 7,
    durationMs: 300,
    swingArcDeg: 110,
    meleeStyle: MeleeStyle.STAB,
    headRadius: 1.2,
    shaftDamageMult: 0.65,
    knockback: 2,
    goreFactor: 0.8,
    baseAccuracy: 0.84,
    weaponClassSkillId: 'stabbing',
    weaponTypeSkillId: 'sword',
  }),
  bow: combatProfile({
    weaponType: WeaponType.RANGED,
    baseDamage: 16,
    cooldownMs: 900,
    range: 44,
    projectileSpeed: 0.75,
    pierce: 1,
    goreFactor: 0.8,
    baseAccuracy: 0.75,
    weaponClassSkillId: 'ranged',
    weaponTypeSkillId: 'bow',
  }),
  firearm: combatProfile({
    weaponType: WeaponType.RANGED,
    baseDamage: 14,
    cooldownMs: 650,
    range: 42,
    projectileSpeed: 1,
    goreFactor: 0.35,
    baseAccuracy: 0.8,
    weaponClassSkillId: 'ranged',
    weaponTypeSkillId: 'pistol',
  }),
  thrown: combatProfile({
    weaponType: WeaponType.THROWN,
    baseDamage: 11,
    cooldownMs: 700,
    range: 22,
    projectileSpeed: 0.8,
    returnSpeed: 0.65,
    maxRange: 22,
    goreFactor: 0.65,
    baseAccuracy: 0.75,
    weaponClassSkillId: 'throwing',
    weaponTypeSkillId: 'throwing-weapons',
  }),
  'magic-focus': combatProfile({
    weaponType: WeaponType.MAGIC,
    baseDamage: 10,
    cooldownMs: 800,
    range: 34,
    projectileSpeed: 0.55,
    aoeRadius: 4,
    goreFactor: 0,
    baseAccuracy: 0.88,
    weaponClassSkillId: 'arcane',
    weaponTypeSkillId: 'spellcraft',
  }),
  beam: combatProfile({
    weaponType: WeaponType.BEAM,
    baseDamage: 3,
    cooldownMs: 1_400,
    range: 28,
    durationMs: 800,
    beamTickMs: 100,
    beamLength: 28,
    goreFactor: 0,
    baseAccuracy: 0.94,
    weaponClassSkillId: 'arcane',
    weaponTypeSkillId: 'spellcraft',
  }),
  trap: combatProfile({
    weaponType: WeaponType.TRAP,
    baseDamage: 28,
    cooldownMs: 1_900,
    trapArmMs: 500,
    trapTriggerRadius: 4,
    trapExplosionRadius: 7,
    goreFactor: 0.35,
    baseAccuracy: 1,
    weaponClassSkillId: 'arcane',
    weaponTypeSkillId: 'spellcraft',
  }),
} as const;

export type WaveBWeaponFamily = keyof typeof WEAPON_PROFILES;

function isWaveBWeaponFamily(value: string): value is WaveBWeaponFamily {
  return Object.hasOwn(WEAPON_PROFILES, value);
}

interface WaveBWeaponInput {
  readonly stableId: (typeof FLOOR2_EQUIPMENT_WAVE_B_WEAPON_IDS)[number];
  readonly rarity: ItemRarity;
  readonly weightLb: number;
  readonly twoHanded: boolean;
}

const WAVE_B_WEAPON_INPUTS: readonly WaveBWeaponInput[] = [
  { stableId: 'weapon.venom-dirk', rarity: 'uncommon', weightLb: 1, twoHanded: false },
  { stableId: 'weapon.moon-scythe', rarity: 'rare', weightLb: 5, twoHanded: true },
  { stableId: 'weapon.tower-spear', rarity: 'common', weightLb: 8, twoHanded: true },
  { stableId: 'weapon.crystal-cannon', rarity: 'rare', weightLb: 9, twoHanded: true },
  { stableId: 'weapon.baseball-bat', rarity: 'common', weightLb: 6, twoHanded: true },
  { stableId: 'weapon.rivet-gun', rarity: 'uncommon', weightLb: 5, twoHanded: false },
  { stableId: 'weapon.shock-baton', rarity: 'uncommon', weightLb: 3, twoHanded: false },
  { stableId: 'weapon.boarding-axe', rarity: 'common', weightLb: 5, twoHanded: false },
  { stableId: 'weapon.hunting-bola', rarity: 'uncommon', weightLb: 2, twoHanded: false },
  { stableId: 'weapon.spike-shield', rarity: 'rare', weightLb: 7, twoHanded: false },
  { stableId: 'weapon.war-fan', rarity: 'common', weightLb: 1, twoHanded: false },
  { stableId: 'weapon.crescent-glaive', rarity: 'rare', weightLb: 7, twoHanded: true },
  { stableId: 'weapon.siege-bow', rarity: 'rare', weightLb: 8, twoHanded: true },
  { stableId: 'weapon.powder-keg', rarity: 'uncommon', weightLb: 10, twoHanded: true },
  { stableId: 'weapon.acid-flask', rarity: 'common', weightLb: 1, twoHanded: false },
  { stableId: 'weapon.ice-pick', rarity: 'common', weightLb: 2, twoHanded: false },
  { stableId: 'weapon.flame-tongs', rarity: 'uncommon', weightLb: 3, twoHanded: false },
  { stableId: 'weapon.ritual-dagger', rarity: 'rare', weightLb: 1, twoHanded: false },
  { stableId: 'weapon.brass-knuckles', rarity: 'common', weightLb: 2, twoHanded: false },
  { stableId: 'weapon.meteor-hammer', rarity: 'rare', weightLb: 8, twoHanded: true },
  { stableId: 'weapon.harpoon-gun', rarity: 'uncommon', weightLb: 8, twoHanded: true },
  { stableId: 'weapon.plague-censer', rarity: 'rare', weightLb: 4, twoHanded: false },
  { stableId: 'weapon.bone-chakram', rarity: 'uncommon', weightLb: 2, twoHanded: false },
  { stableId: 'weapon.echo-bell', rarity: 'rare', weightLb: 4, twoHanded: false },
  { stableId: 'weapon.void-rapier', rarity: 'rare', weightLb: 3, twoHanded: false },
];

function weaponDef(input: WaveBWeaponInput): WeaponDef {
  const entry = manifestEntry(input.stableId);
  if (entry.category !== 'weapon' || !isWaveBWeaponFamily(entry.family)) {
    throw new Error(`Invalid Floor 2 Wave B weapon classification: ${input.stableId}`);
  }
  return Object.freeze({
    id: input.stableId,
    name: entry.briefInput.name,
    ...WEAPON_PROFILES[entry.family],
  });
}

export const FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS: readonly WeaponDef[] = Object.freeze(
  WAVE_B_WEAPON_INPUTS.map(weaponDef),
);

export interface Floor2WaveBWeaponEquipmentDef extends EquipmentItemDef {
  readonly weaponId: string;
}

export const FLOOR2_EQUIPMENT_WAVE_B_WEAPON_EQUIPMENT_DEFS: readonly Floor2WaveBWeaponEquipmentDef[] =
  Object.freeze(
    WAVE_B_WEAPON_INPUTS.map((input) => {
      const entry = manifestEntry(input.stableId);
      return Object.freeze({
        id: input.stableId,
        name: entry.briefInput.name,
        artKey: entry.runtimeKey,
        slots: input.twoHanded ? (['mainHand', 'offHand'] as const) : (['mainHand'] as const),
        statBonuses: {},
        rarity: input.rarity,
        tags: ['floor2', 'wave-b', 'weapon', `family:${entry.family}`],
        weaponId: input.stableId,
        weightLb: input.weightLb,
      });
    }),
  );

interface WaveBNonWeaponInput {
  readonly stableId: (typeof FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_IDS)[number];
  readonly slots: readonly EquipmentSlotId[];
  readonly statBonuses: EquipmentItemDef['statBonuses'];
  readonly rarity: ItemRarity;
  readonly weightLb: number;
}

const WAVE_B_NON_WEAPON_INPUTS: readonly WaveBNonWeaponInput[] = [
  {
    stableId: 'head.quartermaster-cap',
    slots: ['head'],
    statBonuses: { armor: 1, charisma: 1 },
    rarity: 'uncommon',
    weightLb: 1,
  },
  {
    stableId: 'head.batfolk-hood',
    slots: ['head'],
    statBonuses: { armor: 1, dexterity: 1 },
    rarity: 'uncommon',
    weightLb: 1,
  },
  {
    stableId: 'head.alchemist-goggles',
    slots: ['head'],
    statBonuses: { armor: 1, intelligence: 1 },
    rarity: 'rare',
    weightLb: 1,
  },
  {
    stableId: 'torso.chain-hauberk',
    slots: ['chest'],
    statBonuses: { armor: 5, constitution: 1 },
    rarity: 'common',
    weightLb: 14,
  },
  {
    stableId: 'torso.velvet-coat',
    slots: ['chest'],
    statBonuses: { armor: 2, charisma: 1 },
    rarity: 'uncommon',
    weightLb: 4,
  },
  {
    stableId: 'torso.scavenger-harness',
    slots: ['chest'],
    statBonuses: { armor: 3, strength: 1 },
    rarity: 'common',
    weightLb: 7,
  },
  {
    stableId: 'torso.runed-cuirass',
    slots: ['chest'],
    statBonuses: { armor: 6, intelligence: 1 },
    rarity: 'rare',
    weightLb: 13,
  },
  {
    stableId: 'hands.duelist-gloves',
    slots: ['gloves'],
    statBonuses: { armor: 1, dexterity: 1 },
    rarity: 'uncommon',
    weightLb: 1,
  },
  {
    stableId: 'hands.thorn-gauntlets',
    slots: ['gloves'],
    statBonuses: { armor: 3, strength: 1 },
    rarity: 'rare',
    weightLb: 5,
  },
  {
    stableId: 'hands.tinker-grips',
    slots: ['gloves'],
    statBonuses: { armor: 1, intelligence: 1 },
    rarity: 'common',
    weightLb: 1,
  },
  {
    stableId: 'feet.iron-greaves',
    slots: ['legs'],
    statBonuses: { armor: 4, constitution: 1 },
    rarity: 'common',
    weightLb: 8,
  },
  {
    stableId: 'feet.shadow-boots',
    slots: ['feet'],
    statBonuses: { armor: 1, moveSpeed: 0.05 },
    rarity: 'rare',
    weightLb: 2,
  },
  {
    stableId: 'feet.merchant-sandals',
    slots: ['feet'],
    statBonuses: { moveSpeed: 0.03, charisma: 1 },
    rarity: 'uncommon',
    weightLb: 1,
  },
  {
    stableId: 'accessory.compass-charm',
    slots: ['ring2'],
    statBonuses: { luck: 1 },
    rarity: 'common',
    weightLb: 0.25,
  },
  {
    stableId: 'accessory.lucky-feather',
    slots: ['ring1'],
    statBonuses: { luck: 2 },
    rarity: 'rare',
    weightLb: 0.1,
  },
  {
    stableId: 'accessory.gearwork-locket',
    slots: ['neck'],
    statBonuses: { intelligence: 1 },
    rarity: 'uncommon',
    weightLb: 0.5,
  },
  {
    stableId: 'accessory.warding-bell',
    slots: ['offHand'],
    statBonuses: { dodgeChance: 0.02 },
    rarity: 'rare',
    weightLb: 2,
  },
  {
    stableId: 'accessory.surveyor-map',
    slots: ['mainHand'],
    statBonuses: { xpBonus: 0.03 },
    rarity: 'common',
    weightLb: 1,
  },
];

export const FLOOR2_EQUIPMENT_WAVE_B_NON_WEAPON_DEFS: readonly EquipmentItemDef[] = Object.freeze(
  WAVE_B_NON_WEAPON_INPUTS.map((input) => {
    const entry = manifestEntry(input.stableId);
    if (entry.category === 'weapon') {
      throw new Error(`Invalid Floor 2 Wave B non-weapon classification: ${input.stableId}`);
    }
    return Object.freeze({
      id: input.stableId,
      name: waveBDisplayName(input.stableId, entry.briefInput.name),
      artKey: entry.runtimeKey,
      slots: input.slots,
      statBonuses: input.statBonuses,
      rarity: input.rarity,
      tags: ['floor2', 'wave-b', entry.category, `family:${entry.family}`],
      weightLb: input.weightLb,
    });
  }),
);
