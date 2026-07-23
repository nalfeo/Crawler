import { MeleeStyle } from './constants.js';
import type { WeaponDef } from './weaponDefs.js';

/**
 * Shared WeaponDef defaulting factory.
 *
 * Both the canonical WEAPON_DEFS catalog (weaponDefs.ts) and the Floor 2
 * Wave A weapon base catalog (data/floor2-weapon-bases.ts) build their
 * WeaponDef entries from this single factory so that default field changes
 * cannot silently diverge between the two catalogs.
 */
export function createWeaponDef(
  partial: Partial<WeaponDef> &
    Pick<
      WeaponDef,
      | 'id'
      | 'name'
      | 'weaponType'
      | 'baseDamage'
      | 'cooldownMs'
      | 'weaponClassSkillId'
      | 'weaponTypeSkillId'
    >,
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
    shaftDamageMult: 1,
    knockback: 0,
    pierce: 0,
    bounceCount: 0,
    goreFactor: 0.5,
    baseAccuracy: 0.85,
    ...partial,
  };
}
