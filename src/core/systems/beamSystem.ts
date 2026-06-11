import { entityExists, hasComponent, query } from 'bitecs';
import { Enemy, Health, LineDamage, Owner, Player, Position, Team } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import type { GameWorld } from '../world.js';

/** Distance from a point to a line segment. */
function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq <= 0.0001) {
    return apx * apx + apy * apy;
  }

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

const BEAM_HIT_HALF_WIDTH = 8;

/** Applies line/beam damage using segment-vs-point checks. */
export function beamSystem(world: GameWorld): void {
  const beams = query(world.ecs, [LineDamage, Position]);
  const { position, lineDamage, team } = world.stores;

  for (const eid of beams) {
    if (eid === undefined || !entityExists(world.ecs, eid)) {
      continue;
    }

    const tickMs = lineDamage.tickMs[eid] ?? 0;
    const lastTickMs = lineDamage.lastTickMs[eid] ?? 0;

    if (tickMs > 0 && world.elapsedMs - lastTickMs < tickMs) {
      continue;
    }

    lineDamage.lastTickMs[eid] = world.elapsedMs;

    const ax = position.x[eid] ?? 0;
    const ay = position.y[eid] ?? 0;
    const dirX = lineDamage.dirX[eid] ?? 1;
    const dirY = lineDamage.dirY[eid] ?? 0;
    const length = lineDamage.length[eid] ?? 0;
    const damage = lineDamage.damage[eid] ?? 0;
    const beamTeam = hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (world.stores.owner.eid[eid] ?? 0) : -1;
    if (
      ownerEid >= 0 &&
      hasComponent(world.ecs, ownerEid, Player) &&
      isEntityInSafeSpace(world, ownerEid)
    ) {
      continue;
    }

    const bx = ax + dirX * length;
    const by = ay + dirY * length;
    const hitDistSq = BEAM_HIT_HALF_WIDTH * BEAM_HIT_HALF_WIDTH;

    // Check all Health entities (not ideal for large counts, but correct)
    const targets = query(world.ecs, [Health, Position]);

    for (const target of targets) {
      if (
        target === undefined ||
        target === eid ||
        target === ownerEid ||
        !entityExists(world.ecs, target)
      ) {
        continue;
      }

      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player)) {
        continue;
      }

      if (beamTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if ((team.id[target] ?? 0) === beamTeam) {
          continue;
        }
      }

      const tx = position.x[target] ?? 0;
      const ty = position.y[target] ?? 0;
      const distSq = pointToSegmentDistSq(tx, ty, ax, ay, bx, by);

      if (distSq <= hitDistSq) {
        applyDamage(
          world,
          target,
          damage,
          position.x[target] ?? 0,
          position.y[target] ?? 0,
          undefined,
          ax,
          ay,
        );
      }
    }
  }
}
