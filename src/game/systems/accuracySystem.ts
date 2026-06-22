/**
 * Accuracy system — computes final shot accuracy and applies angular spread.
 *
 * Accuracy formula (clamped 0.0–1.0):
 *   accuracy = weapon.baseAccuracy
 *             + dexterity × DEX_ACCURACY_BONUS_PER_POINT
 *             + typeSkillLevel × TYPE_SKILL_ACCURACY_BONUS_PER_LEVEL
 *
 * At accuracy 1.0 there is zero spread.
 * At accuracy 0.0 the shot can deviate by ±MAX_ACCURACY_SPREAD_RAD.
 */
import { hasComponent } from 'bitecs';
import { BaseStats } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import type { WeaponDef } from '../../shared/weaponDefs.js';
import {
  DEX_ACCURACY_BONUS_PER_POINT,
  MAX_ACCURACY_SPREAD_RAD,
  TYPE_SKILL_ACCURACY_BONUS_PER_LEVEL,
} from '../../shared/weapon-skills.js';

/**
 * Returns a value 0.0–1.0 representing how accurate the given weapon fires
 * for the given player entity this frame.
 */
export function computeAccuracy(world: GameWorld, playerEid: number, weaponDef: WeaponDef): number {
  let accuracy = weaponDef.baseAccuracy;

  // Dexterity bonus (from base stats component or core stat points)
  if (hasComponent(world.ecs, playerEid, BaseStats)) {
    const dex = world.stores.baseStats.dexterity[playerEid] ?? 0;
    accuracy += dex * DEX_ACCURACY_BONUS_PER_POINT;
  } else {
    // Fall back to coreStatPoints dexterity allocation
    const dex = world.stores.coreStatPoints.dexterity[playerEid] ?? 0;
    accuracy += dex * DEX_ACCURACY_BONUS_PER_POINT;
  }

  // Type-skill accuracy bonus
  if (weaponDef.typeSkillId !== null) {
    const skillState =
      world.skillStatesByEntity.get(playerEid)?.get(weaponDef.typeSkillId) ??
      world.playerSkills.get(weaponDef.typeSkillId);
    if (skillState !== undefined) {
      accuracy += skillState.level * TYPE_SKILL_ACCURACY_BONUS_PER_LEVEL;
    }
  }

  return Math.min(1.0, Math.max(0.0, accuracy));
}

/**
 * Applies angular spread to a normalized direction vector based on accuracy.
 * Uses the world RNG for determinism.
 *
 * Returns the (potentially spread) direction; the caller should re-normalise if
 * needed (this function preserves the unit-vector invariant via cos/sin).
 */
export function applyAccuracySpread(
  dir: { x: number; y: number },
  accuracy: number,
  world: GameWorld,
): { x: number; y: number } {
  if (accuracy >= 1.0) return dir;

  const maxSpread = (1.0 - accuracy) * MAX_ACCURACY_SPREAD_RAD;
  // next() returns [0, 1) — map to [-1, 1) then scale by maxSpread
  const spread = (world.rng.next() * 2 - 1) * maxSpread;
  const baseAngle = Math.atan2(dir.y, dir.x);
  const newAngle = baseAngle + spread;

  return { x: Math.cos(newAngle), y: Math.sin(newAngle) };
}
