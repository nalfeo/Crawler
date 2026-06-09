import { hasComponent } from 'bitecs';
import { AoeOnImpact, EnemyProjectile, Player, Returning } from './components.js';
import type { GameWorld } from './world.js';
import type { CombatTargetMaterial, CombatWeaponType } from '../shared/combat-events.js';
import { WeaponType } from '../shared/constants.js';
import { getEntityTags } from './systems/equipmentSystem.js';

export function resolveTargetMaterial(world: GameWorld, target: number): CombatTargetMaterial {
  if (hasComponent(world.ecs, target, Player)) return 'living';

  const tags = getEntityTags(world, target);
  if (tags.has('mechanical') || tags.has('robotic') || tags.has('construct')) {
    return 'mechanical';
  }
  if (tags.has('undead')) {
    return 'undead';
  }
  return 'living';
}

export function resolveProjectileWeaponType(world: GameWorld, eid: number): CombatWeaponType {
  if (hasComponent(world.ecs, eid, EnemyProjectile)) return 'enemy-projectile';
  if (hasComponent(world.ecs, eid, AoeOnImpact)) return WeaponType.MAGIC;
  if (hasComponent(world.ecs, eid, Returning)) return WeaponType.THROWN;
  return WeaponType.RANGED;
}
