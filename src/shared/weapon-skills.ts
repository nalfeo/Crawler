/**
 * Weapon skill taxonomy.
 *
 * Combat skills come in two tiers:
 *
 * CLASS skills (e.g. Slashing, Smashing) — one per broad attack style.
 *   - Level up more slowly (2 levels by end of floor 1).
 *   - Grant flat damage bonuses.
 *
 * TYPE skills (e.g. Sword, Dagger) — one per weapon family.
 *   - Level up faster (4 levels by end of floor 1).
 *   - Grant accuracy and attack-speed bonuses.
 *
 * A weapon registers both; using it emits a usage event for each.
 */

// --- Class skills ---

export const WEAPON_CLASS_SKILL_IDS = [
  'slashing',
  'stabbing',
  'smashing',
  'ranged',
  'forearms',
] as const;

export type WeaponClassSkillId = (typeof WEAPON_CLASS_SKILL_IDS)[number];

// --- Type skills ---

export const WEAPON_TYPE_SKILL_IDS = [
  'sword',
  'dagger',
  'sports-equipment',
  'bow',
  'crossbow',
  'pistol',
  'heavy-weapon',
  'thrown',
] as const;

export type WeaponTypeSkillId = (typeof WEAPON_TYPE_SKILL_IDS)[number];

export type WeaponSkillId = WeaponClassSkillId | WeaponTypeSkillId;

// --- Accuracy tuning ---

/**
 * Maximum spread angle (radians) when accuracy = 0.
 * At accuracy 1.0 there is no spread; at 0.0 the shot can deviate by this amount.
 */
export const MAX_ACCURACY_SPREAD_RAD = 0.45; // ~25°

/**
 * Accuracy bonus granted per point of Dexterity (primary stat).
 * Stacks with type-skill accuracy and the weapon's base accuracy value.
 */
export const DEX_ACCURACY_BONUS_PER_POINT = 0.015;

/**
 * Accuracy bonus per level of the matching weapon TYPE skill.
 * 4 levels (end of floor 1) → +0.04 accuracy from skill alone.
 */
export const TYPE_SKILL_ACCURACY_BONUS_PER_LEVEL = 0.01;
