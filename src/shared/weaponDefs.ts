import { MeleeStyle, WEAPON, WeaponType, type MeleeStyleValue, type WeaponTypeValue } from './constants.js';

export interface WeaponDef {
  readonly id: string;
  readonly name: string;
  readonly weaponType: WeaponTypeValue;
  readonly baseDamage: number;
  readonly cooldownMs: number;
  readonly range: number;
  /** Projectile speed (for RANGED, MAGIC, THROWN). */
  readonly projectileSpeed: number;
  /** AoE radius on impact (MAGIC) or swing radius (MELEE, UNARMED). */
  readonly aoeRadius: number;
  /** Duration of active attack in ms (MELEE, UNARMED, BEAM). */
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
  /** Knockback displacement in pixels applied on hit (0 = no knockback). */
  readonly knockback: number;
}

function def(partial: Partial<WeaponDef> & Pick<WeaponDef, 'id' | 'name' | 'weaponType' | 'baseDamage' | 'cooldownMs'>): WeaponDef {
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
    ...partial,
  };
}

export const WEAPON_DEFS: ReadonlyMap<string, WeaponDef> = new Map([
  // --- Melee ---
  ['sword', def({
    id: 'sword', name: 'Sword', weaponType: WeaponType.MELEE,
    baseDamage: 15, cooldownMs: 600, range: WEAPON.MELEE_RANGE,
    aoeRadius: WEAPON.MELEE_RANGE, durationMs: WEAPON.MELEE_DURATION_MS,
    swingArcDeg: 90,
  })],
  ['knife', def({
    id: 'knife', name: 'Knife', weaponType: WeaponType.MELEE,
    baseDamage: 8, cooldownMs: 300, range: 28,
    aoeRadius: 28, durationMs: 150,
    meleeStyle: MeleeStyle.STAB,
  })],
  ['hammer', def({
    id: 'hammer', name: 'Hammer', weaponType: WeaponType.MELEE,
    baseDamage: 25, cooldownMs: 1000, range: 48,
    aoeRadius: 48, durationMs: 300,
    headRadius: 14, shaftDamageMult: 0.5, knockback: 30,
  })],

  // --- Ranged ---
  ['pistol', def({
    id: 'pistol', name: 'Pistol', weaponType: WeaponType.RANGED,
    baseDamage: WEAPON.BASE_DAMAGE, cooldownMs: WEAPON.FIRE_RATE_MS,
    range: 300, projectileSpeed: WEAPON.PROJECTILE_SPEED,
  })],
  ['bow', def({
    id: 'bow', name: 'Bow', weaponType: WeaponType.RANGED,
    baseDamage: 12, cooldownMs: 700, range: 350,
    projectileSpeed: 6.0,
  })],
  ['crossbow', def({
    id: 'crossbow', name: 'Crossbow', weaponType: WeaponType.RANGED,
    baseDamage: 18, cooldownMs: 1200, range: 400,
    projectileSpeed: 8.0,
  })],

  // --- Unarmed ---
  ['punch', def({
    id: 'punch', name: 'Punch', weaponType: WeaponType.UNARMED,
    baseDamage: 5, cooldownMs: 250, range: WEAPON.UNARMED_RANGE,
    aoeRadius: WEAPON.UNARMED_RANGE, durationMs: WEAPON.UNARMED_DURATION_MS,
  })],
  ['kick', def({
    id: 'kick', name: 'Kick', weaponType: WeaponType.UNARMED,
    baseDamage: 7, cooldownMs: 400, range: 30,
    aoeRadius: 30, durationMs: 200,
  })],

  // --- Magic ---
  ['fireball', def({
    id: 'fireball', name: 'Fireball', weaponType: WeaponType.MAGIC,
    baseDamage: 8, cooldownMs: 800, range: 250,
    projectileSpeed: 4.0, aoeRadius: WEAPON.AOE_RADIUS,
  })],

  // --- Thrown ---
  ['boomerang', def({
    id: 'boomerang', name: 'Boomerang', weaponType: WeaponType.THROWN,
    baseDamage: 10, cooldownMs: 900, range: WEAPON.THROWN_MAX_RANGE,
    projectileSpeed: WEAPON.PROJECTILE_SPEED,
    returnSpeed: WEAPON.THROWN_RETURN_SPEED,
    maxRange: WEAPON.THROWN_MAX_RANGE,
  })],
  ['throwing-knife', def({
    id: 'throwing-knife', name: 'Throwing Knife', weaponType: WeaponType.THROWN,
    baseDamage: 6, cooldownMs: 350, range: 150,
    projectileSpeed: 7.0,
    returnSpeed: 5.0,
    maxRange: 150,
  })],

  // --- Beam ---
  ['laser', def({
    id: 'laser', name: 'Laser', weaponType: WeaponType.BEAM,
    baseDamage: 3, cooldownMs: 1500, range: WEAPON.BEAM_LENGTH,
    beamLength: WEAPON.BEAM_LENGTH,
    durationMs: WEAPON.BEAM_DURATION_MS,
    beamTickMs: WEAPON.BEAM_TICK_MS,
  })],

  // --- Traps ---
  ['landmine', def({
    id: 'landmine', name: 'Landmine', weaponType: WeaponType.TRAP,
    baseDamage: 30, cooldownMs: 2000, range: 0,
    trapArmMs: WEAPON.TRAP_ARM_MS,
    trapTriggerRadius: WEAPON.TRAP_TRIGGER_RADIUS,
    trapExplosionRadius: WEAPON.TRAP_EXPLOSION_RADIUS,
  })],
]);

export function getWeaponDef(id: string): WeaponDef | undefined {
  return WEAPON_DEFS.get(id);
}
