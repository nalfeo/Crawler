import { hasComponent } from 'bitecs';
import { FamilyMembership } from '../core/components.js';
import type { GameWorld } from '../core/world.js';

export function isEnemyCombatEligible(world: GameWorld, enemyEid: number): boolean {
  if (
    world.floor !== 2 ||
    !hasComponent(world.ecs, enemyEid, FamilyMembership) ||
    (world.stores.familyMembership.isBoss[enemyEid] ?? 0) !== 1
  ) {
    return true;
  }

  const familyState = world.floorExtendedState?.familyState;
  const familyIndex = world.stores.familyMembership.familyId[enemyEid] ?? -1;
  const familyId = familyState?.presentFamilies[familyIndex];
  if (!familyId) {
    return false;
  }

  return (
    world.goalFlags.get(`floor2-den-${familyId}-unlocked`) === true &&
    familyState?.bossEncounters?.get(familyId)?.started === true
  );
}
