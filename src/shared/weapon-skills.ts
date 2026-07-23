/**
 * Weapon skill taxonomy: class skills and type skills.
 *
 * CLASS skills cover broad combat styles (Slashing, Smashing, Ranged…).
 * They level slowly and grant DAMAGE bonuses.
 *
 * TYPE skills cover specific weapon families (Sword, Dagger, Bow…).
 * They level faster and grant ACCURACY bonuses.
 *
 * Each WeaponDef carries both a weaponClassSkillId and a weaponTypeSkillId.
 * Both receive a `weapon_fired` usage event whenever the player fires that weapon.
 */

/** IDs for weapon class skills — broad combat style groups. */
export const WEAPON_CLASS_SKILL_IDS = [
  'slashing',
  'stabbing',
  'smashing',
  'ranged',
  'throwing',
  'forearms',
  'arcane',
] as const;

export type WeaponClassSkillId = (typeof WEAPON_CLASS_SKILL_IDS)[number];

/** IDs for weapon type skills — specific weapon families within a class. */
export const WEAPON_TYPE_SKILL_IDS = [
  'sword',
  'dagger',
  'hammer',
  'sports-equipment',
  'bow',
  'crossbow',
  'pistol',
  'throwing-weapons',
  'unarmed',
  'spellcraft',
] as const;

export type WeaponTypeSkillId = (typeof WEAPON_TYPE_SKILL_IDS)[number];

/** A skill ID string that belongs to either the class or type taxonomy. */
export type WeaponSkillId = WeaponClassSkillId | WeaponTypeSkillId;

/**
 * Check if a string is a valid weapon class skill id.
 */
export function isWeaponClassSkillId(id: string): id is WeaponClassSkillId {
  return (WEAPON_CLASS_SKILL_IDS as readonly string[]).includes(id);
}

/**
 * Check if a string is a valid weapon type skill id.
 */
export function isWeaponTypeSkillId(id: string): id is WeaponTypeSkillId {
  return (WEAPON_TYPE_SKILL_IDS as readonly string[]).includes(id);
}

export function weaponSkillPrerequisiteMatches(
  prerequisite: WeaponSkillId,
  weaponClassSkillId: WeaponClassSkillId,
  weaponTypeSkillId: WeaponTypeSkillId,
): boolean {
  return weaponClassSkillId === prerequisite || weaponTypeSkillId === prerequisite;
}

/**
 * Usage thresholds for weapon CLASS skills (damage focus, slow leveling).
 * Target: level 2 by end of floor 1 (~200 weapon fires).
 * 20 values required (SKILL_HARD_CAP = 20).
 */
export const CLASS_SKILL_THRESHOLDS: readonly number[] = [
  30, 80, 180, 330, 530, 780, 1_080, 1_430, 1_830, 2_280, 2_780, 3_330, 3_930, 4_580, 5_280, 6_030,
  6_830, 7_680, 8_580, 9_530,
];

/**
 * Usage thresholds for weapon TYPE skills (accuracy focus, fast leveling).
 * Target: level 4 by end of floor 1 (~200 weapon fires).
 * 20 values required (SKILL_HARD_CAP = 20).
 */
export const TYPE_SKILL_THRESHOLDS: readonly number[] = [
  10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1_135, 1_290, 1_455, 1_630,
  1_815, 2_010,
];
