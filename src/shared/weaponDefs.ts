import {
  MeleeStyle,
  WEAPON,
  WeaponType,
  type MeleeStyleValue,
  type WeaponTypeValue,
} from './constants.js';
import type { WeaponClassSkillId, WeaponTypeSkillId } from './weapon-skills.js';
import { FLOOR2_WEAPON_WAVE_A_BASES } from './data/floor2-weapon-bases.js';
import { createWeaponDef } from './weapon-def-defaults.js';
import { FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS } from './data/floor2-equipment-wave-b.js';
import { FLOOR2_BASIC_LEATHER_WEAPON_BASES } from './data/floor2-basic-leather-bases.js';

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
   * Base hit chance (0.0–1.0) before dexterity and skill bonuses.
   * Accuracy bonuses from stats are added on top; result is clamped to [0,1].
   * Ranged weapons are less forgiving than melee; traps always hit.
   */
  readonly baseAccuracy: number;
  /** Weapon class skill that levels up (slowly) when this weapon fires. Grants damage. */
  readonly weaponClassSkillId: WeaponClassSkillId;
  /** Weapon type skill that levels up (quickly) when this weapon fires. Grants accuracy. */
  readonly weaponTypeSkillId: WeaponTypeSkillId;
}

/** @see createWeaponDef in weapon-def-defaults.ts (shared with Floor 2 Wave A bases) */
const def = createWeaponDef;

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
      baseAccuracy: 0.9,
      weaponClassSkillId: 'slashing',
      weaponTypeSkillId: 'sword',
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
      baseAccuracy: 0.85,
      weaponClassSkillId: 'stabbing',
      weaponTypeSkillId: 'dagger',
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
      baseAccuracy: 0.85,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'hammer',
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
      baseAccuracy: 0.85,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'sports-equipment',
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
      baseAccuracy: 0.8,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'pistol',
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
      projectileSpeed: 0.75,
      pierce: 1,
      goreFactor: 0.8,
      baseAccuracy: 0.75,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'bow',
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
      projectileSpeed: 1.0,
      goreFactor: 0.85,
      baseAccuracy: 0.8,
      weaponClassSkillId: 'ranged',
      weaponTypeSkillId: 'crossbow',
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
      baseAccuracy: 0.85,
      weaponClassSkillId: 'forearms',
      weaponTypeSkillId: 'unarmed',
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
      baseAccuracy: 0.85,
      weaponClassSkillId: 'forearms',
      weaponTypeSkillId: 'unarmed',
    }),
  ],

  // --- Magic ---
  [
    'fireball',
    def({
      id: 'fireball',
      name: 'Fire Wand',
      baseDamage: 8,
      cooldownMs: 800,
      range: 32,
      projectileSpeed: 0.5,
      aoeRadius: 6,
      goreFactor: 0.0,
      baseAccuracy: 0.85,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
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
      baseAccuracy: 0.7,
      weaponClassSkillId: 'throwing',
      weaponTypeSkillId: 'throwing-weapons',
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
      projectileSpeed: 0.875,
      returnSpeed: 0,
      maxRange: 0,
      goreFactor: 0.95,
      baseAccuracy: 0.75,
      weaponClassSkillId: 'throwing',
      weaponTypeSkillId: 'throwing-weapons',
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
      projectileSpeed: 0.5625,
      pierce: 12,
      bounceCount: 6,
      goreFactor: 0.05,
      baseAccuracy: 0.65,
      weaponClassSkillId: 'smashing',
      weaponTypeSkillId: 'sports-equipment',
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
      baseAccuracy: 0.95,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
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
      baseAccuracy: 1.0,
      weaponClassSkillId: 'arcane',
      weaponTypeSkillId: 'spellcraft',
    }),
  ],
  ...FLOOR2_WEAPON_WAVE_A_BASES.map(
    (definition) => [definition.weaponDef.id, definition.weaponDef] as const,
  ),
  ...FLOOR2_EQUIPMENT_WAVE_B_WEAPON_DEFS.map(
    (weaponDefinition) => [weaponDefinition.id, weaponDefinition] as const,
  ),
  ...FLOOR2_BASIC_LEATHER_WEAPON_BASES.map(
    (definition) => [definition.weaponDef.id, definition.weaponDef] as const,
  ),
]);

export function getWeaponDef(id: string): WeaponDef | undefined {
  return WEAPON_DEFS.get(id);
}
