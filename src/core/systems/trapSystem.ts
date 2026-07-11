import { entityExists, hasComponent, query, removeEntity } from 'bitecs';
import { Enemy, Health, Owner, Player, Position, Team, Trap } from '../components.js';
import { clearEntityStores, spawnAreaAttack } from '../helpers.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import type { GameWorld } from '../world.js';
import { clearAttackSkillSource } from '../weapon-skill-bridge.js';
import type { CollisionResult } from './collisionSystem.js';

/** Arms traps and triggers them when enemies enter trigger radius. */
export function trapSystem(world: GameWorld, collisionResult: CollisionResult): void {
  const traps = query(world.ecs, [Trap, Position]);
  const { position, trap, team } = world.stores;

  for (const eid of traps) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const armAt = trap.armAtMs[eid] ?? 0;

    // Not yet armed
    if (world.elapsedMs < armAt) {
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const triggerRadius = trap.triggerRadius[eid] ?? 0;
    const trapTeam = hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (world.stores.owner.eid[eid] ?? 0) : -1;
    if (
      ownerEid >= 0 &&
      hasComponent(world.ecs, ownerEid, Player) &&
      isEntityInSafeSpace(world, ownerEid)
    ) {
      continue;
    }

    const candidates = collisionResult.grid.queryRadius(x, y, triggerRadius);
    let triggered = false;

    for (const target of candidates) {
      if (target === undefined || target === eid || target === ownerEid) {
        continue;
      }

      if (!hasComponent(world.ecs, target, Health)) {
        continue;
      }

      if (!hasComponent(world.ecs, target, Enemy)) {
        continue;
      }

      // Skip same-team
      if (trapTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if ((team.id[target] ?? 0) === trapTeam) {
          continue;
        }
      }

      triggered = true;
      break;
    }

    if (triggered) {
      const explosionRadius = trap.explosionRadius[eid] ?? 0;
      const explosionDamage = trap.explosionDamage[eid] ?? 0;
      const explosionTeam = trapTeam >= 0 ? trapTeam : 0;

      // Capture skill source before destroying the trap entity so the
      // explosion inherits the correct weapon attribution.
      const skillSource = world.attackSkillSources.get(eid);

      // Spawn explosion AoE (hits once, very short duration)
      const aoeEid = spawnAreaAttack(
        world,
        x,
        y,
        ownerEid,
        explosionDamage,
        explosionRadius,
        50,
        explosionTeam,
      );

      // Propagate the skill source so the explosion credits the same weapon
      // as the trap that spawned it.
      if (skillSource !== undefined) {
        world.attackSkillSources.set(aoeEid, skillSource);
      }

      clearAttackSkillSource(world, eid);
      clearEntityStores(world, eid);
      removeEntity(world.ecs, eid);
    }
  }
}
