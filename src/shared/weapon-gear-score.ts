import { WeaponType } from './constants.js';
import type { WeaponDef } from './weaponDefs.js';

export interface WeaponScoreBreakdown {
  readonly sustainedDamage: number;
  readonly accuracy: number;
  readonly delivery: number;
  readonly safety: number;
  readonly control: number;
  readonly total: number;
}

export function scoreWeaponDefinition(weapon: WeaponDef): WeaponScoreBreakdown {
  const attacksPerSecond = 1000 / weapon.cooldownMs;
  // Runtime beam hit tracking permits one hit per target per activation; beam
  // ticks only let late entrants be acquired and must not multiply damage.
  const sustainedDamage = weapon.baseDamage * attacksPerSecond;
  const accuracy = Math.max(0, Math.min(1, weapon.baseAccuracy));
  const areaRadius =
    weapon.weaponType === WeaponType.MELEE
      ? 0
      : Math.max(weapon.aoeRadius, weapon.trapExplosionRadius);
  const areaTargets = 1 + Math.min(0.75, areaRadius * 0.06);
  const pierceTargets = 1 + Math.min(0.75, weapon.pierce * 0.18 + weapon.bounceCount * 0.12);
  const meleeArc =
    weapon.weaponType === WeaponType.MELEE
      ? 0.9 + Math.min(0.6, Math.max(1, weapon.swingArcDeg) / 600)
      : 1;
  const delivery = Math.max(areaTargets, pierceTargets) * meleeArc;
  const effectiveRange = Math.max(weapon.range, weapon.beamLength, weapon.maxRange);
  const safety = 1 + Math.min(0.25, effectiveRange * 0.005);
  const projectileReliability =
    weapon.weaponType === WeaponType.RANGED ||
    weapon.weaponType === WeaponType.MAGIC ||
    weapon.weaponType === WeaponType.THROWN
      ? 0.85 + Math.min(0.15, weapon.projectileSpeed * 0.15)
      : 1;
  const trapDelay = weapon.weaponType === WeaponType.TRAP ? 1 / (1 + weapon.trapArmMs / 2_000) : 1;
  const control = weapon.knockback * 0.35 + weapon.trapTriggerRadius * 0.2;
  const total =
    sustainedDamage * accuracy * delivery * safety * projectileReliability * trapDelay + control;
  return { sustainedDamage, accuracy, delivery, safety, control, total };
}

export function calibrateWeaponBaseDamage(weapon: WeaponDef, targetScore: number): number {
  const zero = scoreWeaponDefinition({ ...weapon, baseDamage: 0 }).total;
  const unit = scoreWeaponDefinition({ ...weapon, baseDamage: 1 }).total - zero;
  if (!(unit > 0)) throw new Error(`Weapon ${weapon.id} has no score-bearing damage delivery`);
  return Math.max(1, (targetScore - zero) / unit);
}
