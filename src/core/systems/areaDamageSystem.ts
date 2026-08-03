import { entityExists, hasComponent, query } from 'bitecs';
import { AreaDamage, Enemy, Health, Owner, Player, Position, Team } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { readDamageMeta } from '../damage-meta.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import { getWorldFloorBehavior } from '../floor-behavior.js';
import type { GameWorld } from '../world.js';
import type { CollisionResult } from './collisionSystem.js';
import { emitWeaponHitSkillEventsForSource } from '../weapon-skill-bridge.js';
import { recordWeaponEnemyHit, pruneAttackEntity } from '../weapon-telemetry.js';

const hitSets = new WeakMap<GameWorld, Map<number, Set<number>>>();

function getHitSet(world: GameWorld, eid: number): Set<number> {
  let worldHits = hitSets.get(world);
  if (worldHits === undefined) {
    worldHits = new Map();
    hitSets.set(world, worldHits);
  }
  let hits = worldHits.get(eid);
  if (hits === undefined) {
    hits = new Set();
    worldHits.set(eid, hits);
  }
  return hits;
}

/** Clean up hit tracking for removed entities. */
export function clearAreaDamageHits(world: GameWorld, eid: number): void {
  const worldHits = hitSets.get(world);
  if (worldHits !== undefined) {
    worldHits.delete(eid);
  }
  world.enemyProjectileArchetypeKeys.delete(eid);
  pruneAttackEntity(world, eid);
}

/** Deals damage to enemies within AreaDamage radius. Uses spatial grid for broad-phase. */
export function areaDamageSystem(world: GameWorld, collisionResult: CollisionResult): void {
  const areaEntities = query(world.ecs, [AreaDamage, Position]);
  const { position, areaDamage, team } = world.stores;

  for (const eid of areaEntities) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const radius = areaDamage.radius[eid] ?? 0;
    const damage = areaDamage.damage[eid] ?? 0;
    const isHitOnce = (areaDamage.hitOnce[eid] ?? 0) !== 0;
    const areaTeam = hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (world.stores.owner.eid[eid] ?? -1) : -1;
    if (
      getWorldFloorBehavior(world).safeRoomWeaponImmunity &&
      ownerEid >= 0 &&
      hasComponent(world.ecs, ownerEid, Player) &&
      isEntityInSafeSpace(world, ownerEid)
    ) {
      continue;
    }
    const arcHalfRad = areaDamage.arcHalfRad[eid] ?? 0;
    const arcCenterRad = areaDamage.arcCenterRad[eid] ?? 0;
    const isArc = arcHalfRad > 0 && arcHalfRad < Math.PI;

    const hitSet = isHitOnce ? getHitSet(world, eid) : undefined;
    const candidates = collisionResult.grid.queryRadius(x, y, radius);

    for (const target of candidates) {
      if (target === undefined || target === eid || !entityExists(world.ecs, target)) {
        continue;
      }

      if (!hasComponent(world.ecs, target, Health)) {
        continue;
      }

      // Skip same-team entities
      if (areaTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        const targetTeam = team.id[target] ?? 0;
        if (targetTeam === areaTeam) {
          continue;
        }
      }

      // Skip owner
      if (ownerEid >= 0) {
        if (target === ownerEid) {
          continue;
        }
      }

      // Skip non-combatants — only damage Player or Enemy entities
      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player)) {
        continue;
      }

      // Arc check: skip targets outside the swing arc
      if (isArc) {
        const tx = (position.x[target] ?? 0) - x;
        const ty = (position.y[target] ?? 0) - y;
        const targetAngle = Math.atan2(ty, tx);
        const delta = Math.atan2(
          Math.sin(targetAngle - arcCenterRad),
          Math.cos(targetAngle - arcCenterRad),
        );
        if (Math.abs(delta) > arcHalfRad) {
          continue;
        }
      }

      if (hitSet !== undefined && hitSet.has(target)) {
        continue;
      }

      const dealt = applyDamage(
        world,
        target,
        damage,
        position.x[target] ?? 0,
        position.y[target] ?? 0,
        {
          ...readDamageMeta(world, eid),
          sourceX: x,
          sourceY: y,
          sourceEid: ownerEid >= 0 ? ownerEid : undefined,
          sourceArchetypeKey: world.enemyProjectileArchetypeKeys.get(eid),
        },
      );

      if (dealt > 0 && ownerEid !== -1 && hasComponent(world.ecs, target, Enemy)) {
        emitWeaponHitSkillEventsForSource(world, ownerEid, eid);
        recordWeaponEnemyHit(world, eid, target);
      }

      if (hitSet !== undefined) {
        hitSet.add(target);
      }
    }
  }
}
