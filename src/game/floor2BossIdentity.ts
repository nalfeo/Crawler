/**
 * Identity validation for Floor 2 family bosses.
 *
 * `Floor2FamilyBossEncounterState.bossEid` is a raw entity id, and bitecs
 * recycles entity ids: once a boss entity is removed, its id can be handed to
 * an unrelated newly spawned entity (trash mobs are spawned every tick by
 * `floor2EnemyDirectorSystem`). A recycled id therefore can satisfy loose
 * checks like `entityExists` — or even `Enemy` + `Health` — while pointing at
 * something that is not the family boss.
 *
 * Both the den-relock latch and the encounter diagnostics must only act on a
 * boss entity whose spatial + boss-identity components are intact AND whose
 * recorded family matches the encounter, so they share this predicate.
 */
import { entityExists, hasComponent } from 'bitecs';
import { Enemy, FamilyMembership, Health, Position } from '../core/components.js';
import type { Floor2FamilyBossEncounterState } from '../core/faction-relations.js';
import type { GameWorld } from '../core/world.js';

/**
 * True when `encounter.bossEid` still refers to this encounter's live family boss.
 *
 * Requires the entity to exist and to carry every component the boss paths read
 * or write (`Position`, `Health`, `Enemy`, `FamilyMembership`), to be flagged
 * `isBoss`, and to report the encounter's own family.
 */
export function isLiveFamilyBoss(
  world: GameWorld,
  encounter: Pick<Floor2FamilyBossEncounterState, 'bossEid' | 'familyId'>,
): boolean {
  const bossEid = encounter.bossEid;
  if (bossEid === null || !entityExists(world.ecs, bossEid)) {
    return false;
  }
  if (
    !hasComponent(world.ecs, bossEid, Position) ||
    !hasComponent(world.ecs, bossEid, Health) ||
    !hasComponent(world.ecs, bossEid, Enemy) ||
    !hasComponent(world.ecs, bossEid, FamilyMembership)
  ) {
    return false;
  }
  if ((world.stores.familyMembership.isBoss[bossEid] ?? 0) !== 1) {
    return false;
  }
  const presentFamilies = world.floorExtendedState?.familyState?.presentFamilies;
  if (!presentFamilies) {
    return false;
  }
  const familyIndex = world.stores.familyMembership.familyId[bossEid] ?? -1;
  return presentFamilies[familyIndex] === encounter.familyId;
}
