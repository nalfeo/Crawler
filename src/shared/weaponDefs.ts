import {
  MeleeStyle,
  WEAPON,
  WeaponType,
  type MeleeStyleValue,
  type WeaponTypeValue,
} from './constants.js';
import type { WeaponClassSkillId, WeaponTypeSkillId } from './weapon-skills.js';

export interface WeaponDef {
  readonly id: string;
  readonly name: string;
  readonly weaponType: WeaponTypeValue;
  readonly baseDamage: number;
  readonly cooldownMs: number;
  readonly range: number;
  /** Projectile speed (for RANGED, MAGIC, THROWN). */
  readonly projectileSpeed: number;
  /** AoE radius on impact (MAGIC) or swing radius (MELEE). */
  readonly aoeRadius: number;
  /** Duration of active attack in ms (MELEE, BEAM). */
  readonly durationMs: number;
  /** Beam-specific tick interval for repeated damage. */
  readonly beamTickMs: number;
  /** Beam length. */
  readonly beamLength: number;
  /** Trap arm delay in ms. */
  readonly trapArmMs: number;
  /** Trap trigger radius. */
  readonly trapTriggerRadius: number;
  /** Trap explosion radius. */
  readonly trapExplosionRadius: number;
  /** Return speed for thrown weapons. */
  readonly returnSpeed: number;
  /** Max range before boomerang returns. */
  readonly maxRange: number;
  /** Melee swing arc in degrees (360 = full circle, 45 = narrow cone). */
  readonly swingArcDeg: number;
  /** Melee attack style (0 = slash/sweep, 1 = stab/thrust). */
  readonly meleeStyle: MeleeStyleValue;
  /** Radius of the weapon head at the tip (0 = no head, uniform damage). */
  readonly headRadius: number;
  /** Damage multiplier for shaft-only hits (1.0 = full damage). */
  readonly shaftDamageMult: number;
  /** Knockback displacement in feet applied on hit (0 = no knockback). */
  readonly knockback: number;
  /** Number of enemies a projectile can pierce through (0 = destroy on first hit). */
  readonly pierce: number;
  /** Number of arena-bound bounces for projectile weapons (0 = no bounce). */
  readonly bounceCount: number;
  /** Gore factor 0..1 — how likely/intense blood splatter is on hit.
   *  Bladed/piercing weapons are high (~0.8–1.0), blunt weapons low (~0.1–0.2). */
  readonly goreFactor: number;
  /**
   * Weapon class skill id — broad attack category (e.g. 'slashing', 'ranged').
   * Using this weapon emits a usage event for this skill, which grants damage bonuses.
   * null for weapons without a class (traps, environmental).
   */
  readonly classSkillId: WeaponClassSkillId | null;
  /**
   * Weapon type skill id — specific weapon family (e.g. 'sword', 'dagger').
   * Using this weapon emits a usage event for this skill, which grants accuracy bonuses.
   * null for weapons without a type (magic, beams without a physical form).
   */
  readonly typeSkillId: WeaponTypeSkillId | null;
  /**
   * Base accuracy of this weapon, 0.0–1.0 (1.0 = perfect aim, no spread).
   * Modified at fire time by dexterity and the weapon's type skill level.
   */
  readonly baseAccuracy: number;
}

function def(
  partial: Partial<WeaponDef> &
    Pick<WeaponDef, 'id' | 'name' | 'weaponType' | 'baseDamage' | 'cooldownMs'>,
): WeaponDef {
  return {
    range: 0,
    projectileSpeed: 0,
    aoeRadius: 0,
    durationMs: 0,
    beamTickMs: 0,
    beamLength: 0,
    trapArmMs: 0,
    trapTriggerRadius: 0,
    trapExplosionRadius: 0,
    returnSpeed: 0,
    maxRange: 0,
    swingArcDeg: 360,
    meleeStyle: MeleeStyle.SLASH,
    headRadius: 0,
    shaftDamageMult: 1.0,
    knockback: 0,
    pierce: 0,
    bounceCount: 0,
    goreFactor: 0.5,
    classSkillId: null,
    typeSkillId: null,
    baseAccuracy: 1.0,
    ...partial,
  };
}

export const WEAPON_DEFS: ReadonlyMap<string, WeaponDef> = new Map([
  // --- Melee ---
  [
    'sword',
    def({
      id: 'sword',
      name: 'Sword',
      weaponType: WeaponType.MELEE,
      baseDamage: 15,
      cooldownMs: 600,
      range: 5,
      aoeRadius: 5,
      durationMs: WEAPON.MELEE_DURATION_MS,
      swingArcDeg: 90,
      goreFactor: 0.9,
      classSkillId: 'slashing',
      typeSkillId: 'sword',
      baseAccuracy: 0.85,
    }),
  ],
  [
    'knife',
    def({
      id: 'knife',
      name: 'Knife',
      weaponType: WeaponType.MELEE,
      baseDamage: 8,
      cooldownMs: 300,
      range: 3.5,
      aoeRadius: 3.5,
      durationMs: 150,
      meleeStyle: MeleeStyle.STAB,
      goreFactor: 1.0,
      classSkillId: 'stabbing',
      typeSkillId: 'dagger',
      baseAccuracy: 0.8,
    }),
  ],
  [
    'hammer',
    def({
      id: 'hammer',
      name: 'Hammer',
      weaponType: WeaponType.MELEE,
      baseDamage: 25,
      cooldownMs: 1000,
      range: 6,
      aoeRadius: 6,
      durationMs: 300,
      headRadius: 1.75,
      shaftDamageMult: 0.5,
      knockback: 4,
      goreFactor: 0.15,
      classSkillId: 'smashing',
      typeSkillId: 'heavy-weapon',
      baseAccuracy: 0.75,
    }),
  ],
  [
    'baseball-bat',
    def({
      id: 'baseball-bat',
      name: 'Baseball Bat',
      weaponType: WeaponType.MELEE,
      baseDamage: 20,
      cooldownMs: 900,
      range: 5.5,
      aoeRadius: 5.5,
      durationMs: 300,
      swingArcDeg: 120,
      headRadius: 1.75,
      shaftDamageMult: 0.4,
      knockback: 5,
      goreFactor: 0.15,
      classSkillId: 'smashing',
      typeSkillId: 'sports-equipment',
      baseAccuracy: 0.8,
    }),
  ],

  // --- Ranged ---
  [
    'pistol',
    def({
      id: 'pistol',
      name: 'Pistol',
      weaponType: WeaponType.RANGED,
      baseDamage: WEAPON.BASE_DAMAGE,
      cooldownMs: WEAPON.FIRE_RATE_MS,
      range: 40,
      projectileSpeed: WEAPON.PROJECTILE_SPEED,
      goreFactor: 0.3,
      classSkillId: 'ranged',
      typeSkillId: 'pistol',
      baseAccuracy: 0.82,
    }),
  ],
  [
    'bow',
    def({
      id: 'bow',
      name: 'Bow',
      weaponType: WeaponType.RANGED,
      baseDamage: 16,
      cooldownMs: 900,
      range: 44,
      projectileSpeed: 6.0,
      pierce: 1,
      goreFactor: 0.8,
      classSkillId: 'ranged',
      typeSkillId: 'bow',
      baseAccuracy: 0.78,
    }),
  ],
  [
    'crossbow',
    def({
      id: 'crossbow',
      name: 'Crossbow',
      weaponType: WeaponType.RANGED,
      baseDamage: 18,
      cooldownMs: 1200,
      range: 50,
      projectileSpeed: 8.0,
      goreFactor: 0.85,
      classSkillId: 'ranged',
      typeSkillId: 'crossbow',
      baseAccuracy: 0.88,
    }),
  ],

  // --- Unarmed ---
  [
    'punch',
    def({
      id: 'punch',
      name: 'Punch',
      weaponType: WeaponType.MELEE,
      baseDamage: 8,
      cooldownMs: 200,
      range: 3,
      aoeRadius: 3,
      durationMs: 120,
      meleeStyle: MeleeStyle.STAB,
      headRadius: 1.25,
      shaftDamageMult: 0,
      knockback: 2.5,
      goreFactor: 0.1,
      classSkillId: 'forearms',
      typeSkillId: null,
      baseAccuracy: 0.9,
    }),
  ],
  [
    'kick',
    def({
      id: 'kick',
      name: 'Kick',
      weaponType: WeaponType.MELEE,
      baseDamage: 7,
      cooldownMs: 400,
      range: 4,
      aoeRadius: 4,
      durationMs: 200,
      goreFactor: 0.1,
      classSkillId: 'forearms',
      typeSkillId: null,
      baseAccuracy: 0.9,
    }),
  ],

  // --- Magic ---
  [
    'fireball',
    def({
      id: 'fireball',
      name: 'Fireball',
      weaponType: WeaponType.MAGIC,
      baseDamage: 8,
      cooldownMs: 800,
      range: 32,
      projectileSpeed: 4.0,
      aoeRadius: 6,
      goreFactor: 0.0,
      classSkillId: 'ranged',
      typeSkillId: null,
      baseAccuracy: 0.92,
    }),
  ],

  // --- Thrown ---
  [
    'boomerang',
    def({
      id: 'boomerang',
      name: 'Boomerang',
      weaponType: WeaponType.THROWN,
      baseDamage: 10,
      cooldownMs: 900,
      range: 25,
      projectileSpeed: WEAPON.PROJECTILE_SPEED,
      returnSpeed: WEAPON.THROWN_RETURN_SPEED,
      maxRange: 25,
      goreFactor: 0.2,
      classSkillId: 'ranged',
      typeSkillId: 'sports-equipment',
      baseAccuracy: 0.8,
    }),
  ],
  [
    'throwing-knife',
    def({
      id: 'throwing-knife',
      name: 'Throwing Knife',
      weaponType: WeaponType.THROWN,
      baseDamage: 6,
      cooldownMs: 350,
      range: 19,
      projectileSpeed: 7.0,
      returnSpeed: 0,
      maxRange: 0,
      goreFactor: 0.95,
      classSkillId: 'stabbing',
      typeSkillId: 'thrown',
      baseAccuracy: 0.75,
    }),
  ],
  [
    'bowling-ball',
    def({
      id: 'bowling-ball',
      name: 'Bowling Ball',
      weaponType: WeaponType.THROWN,
      baseDamage: 18,
      cooldownMs: 1300,
      range: 280,
      projectileSpeed: 4.5,
      pierce: 12,
      bounceCount: 6,
      goreFactor: 0.05,
      classSkillId: 'smashing',
      typeSkillId: 'sports-equipment',
      baseAccuracy: 0.6,
    }),
  ],

  // --- Beam ---
  [
    'laser',
    def({
      id: 'laser',
      name: 'Laser',
      weaponType: WeaponType.BEAM,
      baseDamage: 3,
      cooldownMs: 1500,
      range: 25,
      beamLength: 25,
      durationMs: WEAPON.BEAM_DURATION_MS,
      beamTickMs: WEAPON.BEAM_TICK_MS,
      goreFactor: 0.0,
      classSkillId: 'ranged',
      typeSkillId: null,
      baseAccuracy: 1.0,
    }),
  ],

  // --- Traps ---
  [
    'landmine',
    def({
      id: 'landmine',
      name: 'Landmine',
      weaponType: WeaponType.TRAP,
      baseDamage: 30,
      cooldownMs: 2000,
      range: 0,
      trapArmMs: WEAPON.TRAP_ARM_MS,
      trapTriggerRadius: 4,
      trapExplosionRadius: 8,
      goreFactor: 0.4,
      classSkillId: null,
      typeSkillId: null,
      baseAccuracy: 1.0,
    }),
  ],
]);

export function getWeaponDef(id: string): WeaponDef | undefined {
  return WEAPON_DEFS.get(id);
}
