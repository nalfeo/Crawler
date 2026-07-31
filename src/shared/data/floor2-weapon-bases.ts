import { deepFreeze } from '../canonical-json.js';
import { MeleeStyle, WEAPON, WeaponType } from '../constants.js';
import type { EquipmentSlotId } from '../equipment-slots.js';
import type { EquipmentItemDef } from '../equipment-types.js';
import type { WeaponDef } from '../weaponDefs.js';
import { createWeaponDef } from '../weapon-def-defaults.js';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  type Floor2EquipmentFamily,
  type Floor2EquipmentRuntimeKey,
  type Floor2NonWeaponFamily,
  type Floor2WeaponStableId,
} from './floor2-equipment-art.js';

export type Floor2WeaponBaseFamily = Exclude<Floor2EquipmentFamily, Floor2NonWeaponFamily>;

export interface Floor2WeaponBaseDefinition {
  readonly stableId: Floor2WeaponStableId;
  readonly family: Floor2WeaponBaseFamily;
  readonly artKey: Floor2EquipmentRuntimeKey;
  readonly equipmentDef: EquipmentItemDef;
  readonly weaponDef: WeaponDef;
}

/** @see createWeaponDef in weapon-def-defaults.ts (shared with the canonical WEAPON_DEFS catalog) */
const weaponDef = createWeaponDef;

function base(
  stableId: Floor2WeaponStableId,
  family: Floor2WeaponBaseFamily,
  slots: readonly EquipmentSlotId[],
  weightLb: number,
  definition: WeaponDef,
): Floor2WeaponBaseDefinition {
  const artKey = `equipment/${stableId.replace('.', '/')}` as Floor2EquipmentRuntimeKey;
  return {
    stableId,
    family,
    artKey,
    equipmentDef: {
      id: stableId,
      name: definition.name,
      slots,
      statBonuses: {},
      rarity: 'common',
      tags: [family],
      weaponId: definition.id,
      weightLb,
    },
    weaponDef: definition,
  };
}

export const FLOOR2_WEAPON_WAVE_A_BASES: readonly Floor2WeaponBaseDefinition[] = deepFreeze([
  base(
    'weapon.iron-cleaver',
    'blade',
    ['mainHand'],
    4,
    weaponDef({
      id: 'iron-cleaver',
      name: 'Iron Cleaver',
      weaponType: WeaponType.MELEE,
      baseDamage: 20,
      cooldownMs: 700,
      range: 5,
      aoeRadius: 5,
      durationMs: 250,
      swingArcDeg: 105,
      goreFactor: 0.9,
      baseAccuracy: 0.88,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.bone-saw',
    'blade',
    ['mainHand'],
    2,
    weaponDef({
      id: 'bone-saw',
      name: 'Bone Saw',
      weaponType: WeaponType.MELEE,
      baseDamage: 12,
      cooldownMs: 400,
      range: 4,
      aoeRadius: 4,
      durationMs: 180,
      swingArcDeg: 70,
      goreFactor: 1,
      baseAccuracy: 0.86,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.dueling-saber',
    'blade',
    ['mainHand'],
    2.5,
    weaponDef({
      id: 'dueling-saber',
      name: 'Dueling Saber',
      weaponType: WeaponType.MELEE,
      baseDamage: 14,
      cooldownMs: 450,
      range: 5.5,
      aoeRadius: 5.5,
      durationMs: 180,
      meleeStyle: MeleeStyle.STAB,
      swingArcDeg: 55,
      goreFactor: 0.9,
      baseAccuracy: 0.92,
      weaponClassSkillId: 'stabbing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.war-pick',
    'axe',
    ['mainHand'],
    5,
    weaponDef({
      id: 'war-pick',
      name: 'War Pick',
      weaponType: WeaponType.MELEE,
      baseDamage: 22,
      cooldownMs: 800,
      range: 5,
      aoeRadius: 5,
      durationMs: 260,
      meleeStyle: MeleeStyle.STAB,
      headRadius: 1.25,
      shaftDamageMult: 0.5,
      knockback: 2,
      goreFactor: 0.8,
      baseAccuracy: 0.84,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.butcher-hook',
    'axe',
    ['mainHand'],
    4,
    weaponDef({
      id: 'butcher-hook',
      name: 'Butcher Hook',
      weaponType: WeaponType.MELEE,
      baseDamage: 18,
      cooldownMs: 650,
      range: 5.5,
      aoeRadius: 5.5,
      durationMs: 240,
      swingArcDeg: 120,
      headRadius: 1,
      shaftDamageMult: 0.6,
      knockback: 2,
      goreFactor: 1,
      baseAccuracy: 0.84,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.rune-axe',
    'axe',
    ['mainHand', 'offHand'],
    8,
    weaponDef({
      id: 'rune-axe',
      name: 'Rune Axe',
      weaponType: WeaponType.MELEE,
      baseDamage: 24,
      cooldownMs: 850,
      range: 6,
      aoeRadius: 6,
      durationMs: 300,
      swingArcDeg: 125,
      headRadius: 1.5,
      shaftDamageMult: 0.5,
      knockback: 3,
      goreFactor: 0.85,
      baseAccuracy: 0.83,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.chain-flail',
    'bludgeon',
    ['mainHand'],
    5,
    weaponDef({
      id: 'chain-flail',
      name: 'Chain Flail',
      weaponType: WeaponType.MELEE,
      baseDamage: 19,
      cooldownMs: 750,
      range: 6.5,
      aoeRadius: 6.5,
      durationMs: 300,
      swingArcDeg: 145,
      headRadius: 1.5,
      shaftDamageMult: 0.5,
      knockback: 3,
      goreFactor: 0.25,
      baseAccuracy: 0.8,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.stone-maul',
    'bludgeon',
    ['mainHand', 'offHand'],
    12,
    weaponDef({
      id: 'stone-maul',
      name: 'Stone Maul',
      weaponType: WeaponType.MELEE,
      baseDamage: 28,
      cooldownMs: 1100,
      range: 6,
      aoeRadius: 6,
      durationMs: 350,
      headRadius: 2,
      shaftDamageMult: 0.4,
      knockback: 5,
      goreFactor: 0.15,
      baseAccuracy: 0.8,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.sun-hammer',
    'bludgeon',
    ['mainHand', 'offHand'],
    8,
    weaponDef({
      id: 'sun-hammer',
      name: 'Sun Hammer',
      weaponType: WeaponType.MELEE,
      baseDamage: 35,
      cooldownMs: 1100,
      range: 6,
      aoeRadius: 7,
      durationMs: 350,
      headRadius: 2,
      shaftDamageMult: 0.5,
      knockback: 5,
      goreFactor: 0.2,
      baseAccuracy: 0.82,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.quarterstaff',
    'polearm',
    ['mainHand', 'offHand'],
    4,
    weaponDef({
      id: 'quarterstaff',
      name: 'Quarterstaff',
      weaponType: WeaponType.MELEE,
      baseDamage: 14,
      cooldownMs: 500,
      range: 6.5,
      aoeRadius: 6.5,
      durationMs: 220,
      swingArcDeg: 110,
      headRadius: 1,
      shaftDamageMult: 0.8,
      knockback: 2,
      goreFactor: 0.1,
      baseAccuracy: 0.88,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.blood-lance',
    'polearm',
    ['mainHand', 'offHand'],
    7,
    weaponDef({
      id: 'blood-lance',
      name: 'Blood Lance',
      weaponType: WeaponType.MELEE,
      baseDamage: 21,
      cooldownMs: 800,
      range: 8,
      aoeRadius: 8,
      durationMs: 260,
      meleeStyle: MeleeStyle.STAB,
      swingArcDeg: 45,
      headRadius: 1.25,
      shaftDamageMult: 0.45,
      goreFactor: 0.95,
      baseAccuracy: 0.86,
      weaponClassSkillId: 'stabbing',
      weaponTypeSkillId: 'dagger',
    }),
  ),
  base(
    'weapon.grave-shovel',
    'polearm',
    ['mainHand', 'offHand'],
    8,
    weaponDef({
      id: 'grave-shovel',
      name: 'Grave Shovel',
      weaponType: WeaponType.MELEE,
      baseDamage: 20,
      cooldownMs: 800,
      range: 6,
      aoeRadius: 6,
      durationMs: 300,
      swingArcDeg: 120,
      headRadius: 1.5,
      shaftDamageMult: 0.5,
      knockback: 3,
      goreFactor: 0.4,
      baseAccuracy: 0.82,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
    }),
  ),
  base(
    'weapon.ashwood-bow',
    'bow',
    ['mainHand', 'offHand'],
    4,
    weaponDef({
      id: 'ashwood-bow',
      name: 'Ashwood Bow',
      weaponType: WeaponType.RANGED,
      baseDamage: 15,
      cooldownMs: 850,
      range: 42,
      projectileSpeed: 0.75,
      pierce: 1,
      goreFactor: 0.8,
      baseAccuracy: 0.76,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'bow',
    }),
  ),
  base(
    'weapon.hand-crossbow',
    'bow',
    ['mainHand'],
    3,
    weaponDef({
      id: 'hand-crossbow',
      name: 'Hand Crossbow',
      weaponType: WeaponType.RANGED,
      baseDamage: 13,
      cooldownMs: 650,
      range: 36,
      projectileSpeed: 0.9,
      goreFactor: 0.8,
      baseAccuracy: 0.8,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'crossbow',
    }),
  ),
  base(
    'weapon.storm-sling',
    'bow',
    ['mainHand'],
    1,
    weaponDef({
      id: 'storm-sling',
      name: 'Storm Sling',
      weaponType: WeaponType.RANGED,
      baseDamage: 11,
      cooldownMs: 600,
      range: 38,
      projectileSpeed: 0.65,
      bounceCount: 1,
      goreFactor: 0.25,
      baseAccuracy: 0.72,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'bow',
    }),
  ),
  base(
    'weapon.musketeer-rifle',
    'firearm',
    ['mainHand', 'offHand'],
    9,
    weaponDef({
      id: 'musketeer-rifle',
      name: 'Musketeer Rifle',
      weaponType: WeaponType.RANGED,
      baseDamage: 24,
      cooldownMs: 1200,
      range: 55,
      projectileSpeed: 1,
      pierce: 1,
      goreFactor: 0.65,
      baseAccuracy: 0.75,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'pistol',
    }),
  ),
  base(
    'weapon.cog-pistol',
    'firearm',
    ['mainHand'],
    3,
    weaponDef({
      id: 'cog-pistol',
      name: 'Cog Pistol',
      weaponType: WeaponType.RANGED,
      baseDamage: 12,
      cooldownMs: 500,
      range: 36,
      projectileSpeed: 1,
      goreFactor: 0.4,
      baseAccuracy: 0.78,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'pistol',
    }),
  ),
  base(
    'weapon.throwing-knives',
    'thrown',
    ['mainHand'],
    1,
    weaponDef({
      id: 'throwing-knives',
      name: 'Throwing Knives',
      weaponType: WeaponType.THROWN,
      baseDamage: 7,
      cooldownMs: 300,
      range: 20,
      projectileSpeed: 0.9,
      goreFactor: 0.95,
      baseAccuracy: 0.77,
      weaponClassSkillId: 'throwing',
      weaponTypeSkillId: 'throwing-weapons',
    }),
  ),
  base(
    'weapon.twin-katar',
    'thrown',
    ['mainHand'],
    2,
    weaponDef({
      id: 'twin-katar',
      name: 'Twin Katar',
      weaponType: WeaponType.THROWN,
      baseDamage: 9,
      cooldownMs: 400,
      range: 18,
      projectileSpeed: 0.85,
      returnSpeed: 0.75,
      maxRange: 18,
      goreFactor: 0.95,
      baseAccuracy: 0.76,
      weaponClassSkillId: 'throwing',
      weaponTypeSkillId: 'throwing-weapons',
    }),
  ),
  base(
    'weapon.ember-wand',
    'magic-focus',
    ['mainHand'],
    1.5,
    weaponDef({
      id: 'ember-wand',
      name: 'Ember Wand',
      weaponType: WeaponType.MAGIC,
      baseDamage: 10,
      cooldownMs: 700,
      range: 36,
      projectileSpeed: 0.55,
      aoeRadius: 4,
      goreFactor: 0,
      baseAccuracy: 0.9,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ),
  base(
    'weapon.frost-crook',
    'magic-focus',
    ['mainHand'],
    2,
    weaponDef({
      id: 'frost-crook',
      name: 'Frost Crook',
      weaponType: WeaponType.MAGIC,
      baseDamage: 11,
      cooldownMs: 800,
      range: 34,
      projectileSpeed: 0.5,
      aoeRadius: 5,
      goreFactor: 0,
      baseAccuracy: 0.88,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ),
  base(
    'weapon.alchemist-sprayer',
    'beam',
    ['mainHand', 'offHand'],
    7,
    weaponDef({
      id: 'alchemist-sprayer',
      name: 'Alchemist Sprayer',
      weaponType: WeaponType.BEAM,
      baseDamage: 2,
      cooldownMs: 1200,
      range: 18,
      beamLength: 18,
      durationMs: 1000,
      beamTickMs: 200,
      goreFactor: 0,
      baseAccuracy: 0.95,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ),
  base(
    'weapon.thorn-whip',
    'beam',
    ['mainHand'],
    3,
    weaponDef({
      id: 'thorn-whip',
      name: 'Thorn Whip',
      weaponType: WeaponType.BEAM,
      baseDamage: 4,
      cooldownMs: 1000,
      range: 20,
      beamLength: 20,
      durationMs: 750,
      beamTickMs: 250,
      goreFactor: 0.6,
      baseAccuracy: 0.9,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ),
  base(
    'weapon.sawblade-launcher',
    'trap',
    ['mainHand', 'offHand'],
    10,
    weaponDef({
      id: 'sawblade-launcher',
      name: 'Sawblade Launcher',
      weaponType: WeaponType.TRAP,
      baseDamage: 24,
      cooldownMs: 1800,
      trapArmMs: 500,
      trapTriggerRadius: 4,
      trapExplosionRadius: 6,
      goreFactor: 0.9,
      baseAccuracy: 1,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
    }),
  ),
  base(
    'weapon.oil-lantern',
    'trap',
    ['mainHand'],
    4,
    weaponDef({
      id: 'oil-lantern',
      name: 'Oil Lantern',
      weaponType: WeaponType.TRAP,
      baseDamage: 18,
      cooldownMs: 1600,
      trapArmMs: WEAPON.TRAP_ARM_MS,
      trapTriggerRadius: 5,
      trapExplosionRadius: 7,
      goreFactor: 0.15,
      baseAccuracy: 1,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ),
]);

const EXPECTED_FAMILY_COUNTS: Readonly<Record<Floor2WeaponBaseFamily, number>> = {
  blade: 3,
  axe: 3,
  bludgeon: 3,
  polearm: 3,
  bow: 3,
  firearm: 2,
  thrown: 2,
  'magic-focus': 2,
  beam: 2,
  trap: 2,
  // Classic Fantasy [Basic Leather] bases live in floor2-basic-leather-bases.ts,
  // not Wave A — this family contributes zero bases here.
  'basic-leather': 0,
};

function validateWaveABases(): void {
  if (FLOOR2_WEAPON_WAVE_A_BASES.length !== 25) {
    throw new Error(
      `Floor 2 weapon wave A must contain exactly 25 bases; received ${FLOOR2_WEAPON_WAVE_A_BASES.length}`,
    );
  }
  const stableIds = new Set<string>();
  const weaponIds = new Set<string>();
  for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
    if (stableIds.has(definition.stableId)) {
      throw new Error(`Duplicate Floor 2 weapon wave A stable ID: ${definition.stableId}`);
    }
    if (weaponIds.has(definition.weaponDef.id)) {
      throw new Error(`Duplicate Floor 2 weapon wave A weapon ID: ${definition.weaponDef.id}`);
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
      throw new Error(`Floor 2 weapon wave A mapping drift: ${definition.stableId}`);
    }
    if (
      definition.equipmentDef.id !== definition.stableId ||
      definition.equipmentDef.weaponId !== definition.weaponDef.id ||
      definition.equipmentDef.name !== definition.weaponDef.name ||
      definition.equipmentDef.rarity !== 'common' ||
      Object.keys(definition.equipmentDef.statBonuses).length !== 0
    ) {
      throw new Error(`Invalid Floor 2 weapon wave A base contract: ${definition.stableId}`);
    }
  }
  for (const [family, expectedCount] of Object.entries(EXPECTED_FAMILY_COUNTS)) {
    const actualCount = FLOOR2_WEAPON_WAVE_A_BASES.filter(
      (definition) => definition.family === family,
    ).length;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Floor 2 weapon wave A family ${family} expected ${expectedCount} bases; received ${actualCount}`,
      );
    }
  }
}

validateWaveABases();

const FLOOR2_WEAPON_WAVE_A_BY_ID = new Map(
  FLOOR2_WEAPON_WAVE_A_BASES.map((definition) => [definition.stableId, definition] as const),
);

export const FLOOR2_WEAPON_WAVE_A_BASE_IDS: readonly Floor2WeaponStableId[] = Object.freeze(
  FLOOR2_WEAPON_WAVE_A_BASES.map((definition) => definition.stableId),
);

export function getFloor2WeaponWaveABase(stableId: string): Floor2WeaponBaseDefinition | undefined {
  return FLOOR2_WEAPON_WAVE_A_BY_ID.get(stableId as Floor2WeaponStableId);
}
