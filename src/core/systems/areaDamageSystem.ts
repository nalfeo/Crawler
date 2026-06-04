import { entityExists, hasComponent, query } from 'bitecs';
import { AreaDamage, Enemy, Health, Owner, Player, Position, Team } from '../components.js';
import type { GameWorld } from '../world.js';
import type { CollisionResult } from './collisionSystem.js';

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
}

/** Deals damage to enemies within AreaDamage radius. Uses spatial grid for broad-phase. */
export function areaDamageSystem(world: GameWorld, collisionResult: CollisionResult): void {
  const areaEntities = query(world.ecs, [AreaDamage, Position]);
  const { position, areaDamage, team, health } = world.stores;

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
      if (hasComponent(world.ecs, eid, Owner)) {
        const ownerEid = world.stores.owner.eid[eid] ?? 0;
        if (target === ownerEid) {
          continue;
        }
      }

      // Skip non-combatants — only damage Player or Enemy entities
      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player)) {
        continue;
      }

      if (hitSet !== undefined && hitSet.has(target)) {
        continue;
      }

      const current = health.current[target] ?? 0;
      health.current[target] = Math.max(0, current - damage);

      if (hitSet !== undefined) {
        hitSet.add(target);
      }
    }
  }
}
