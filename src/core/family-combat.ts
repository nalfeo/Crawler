import { addComponent, entityExists, hasComponent, set } from 'bitecs';
import { Enemy, FamilyMembership, Owner, Player } from './components.js';
import { asFamilyId, bandFor, getRelation } from './faction-relations.js';
import type { GameWorld } from './world.js';

/** Family slot on a combatant or a delayed attack's spawn-time snapshot. */
export function getCombatFamilyIndex(
  world: GameWorld,
  eid: number | undefined,
): number | undefined {
  return eid !== undefined && hasComponent(world.ecs, eid, FamilyMembership)
    ? world.stores.familyMembership.familyId[eid]
    : undefined;
}

export function snapshotCombatFamily(world: GameWorld, attack: number, owner: number): void {
  const familyId = getCombatFamilyIndex(world, owner);
  if (familyId !== undefined) {
    addComponent(world.ecs, attack, set(FamilyMembership, { familyId, isBoss: 0 }));
    world.familyAttackOwnerGeneration.set(attack, world.entityRenderGeneration[owner] ?? 0);
  }
}

/** Undefined leaves non-family combat's existing team rules unchanged. */
export function familyDamagePermission(
  world: GameWorld,
  source: number | undefined,
  target: number,
  sourceFamilyIndex = getCombatFamilyIndex(world, source),
): boolean | undefined {
  if (sourceFamilyIndex === undefined) return undefined;
  if (hasComponent(world.ecs, target, Player)) {
    const family =
      world.floorExtendedState?.familyState?.presentFamilies[sourceFamilyIndex] ??
      asFamilyId(`__slot:${sourceFamilyIndex}`);
    const band = bandFor(getRelation(world, family));
    return band === 'hate' || band === 'hostile';
  }
  const targetFamily = getCombatFamilyIndex(world, target);
  if (targetFamily !== undefined) return sourceFamilyIndex !== targetFamily;
  return hasComponent(world.ecs, target, Enemy) ? true : undefined;
}

/** A delayed family attack must never attribute a hit to a recycled owner. */
export function getCombatSourceEid(world: GameWorld, attack: number): number | undefined {
  if (!hasComponent(world.ecs, attack, Owner)) return undefined;
  const owner = world.stores.owner.eid[attack];
  if (getCombatFamilyIndex(world, attack) === undefined) return owner;
  return owner !== undefined &&
    entityExists(world.ecs, owner) &&
    world.familyAttackOwnerGeneration.get(attack) === world.entityRenderGeneration[owner]
    ? owner
    : undefined;
}
