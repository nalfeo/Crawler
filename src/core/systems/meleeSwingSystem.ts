import { entityExists, hasComponent, query } from 'bitecs';
import { Enemy, Health, MeleeSwing, Owner, Player, Position, Team } from '../components.js';
import type { GameWorld } from '../world.js';

/** Half-width of the blade hitbox in pixels. */
const BLADE_HIT_HALF_WIDTH = 12;

/** Distance from a point to a line segment (squared). */
function pointToSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
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

/** Clean up hit tracking for removed melee swing entities. */
export function clearMeleeSwingHits(world: GameWorld, eid: number): void {
  const worldHits = hitSets.get(world);
  if (worldHits !== undefined) {
    worldHits.delete(eid);
  }
}

/**
 * Melee swing system — handles blade line-segment collision detection.
 *
 * Each MeleeSwing entity represents a blade sweeping through an arc.
 * The system:
 * 1. Follows the owner's position
 * 2. Computes the swept arc from start to current blade angle
 * 3. Checks if enemies fall within the swept region AND blade length
 * 4. Also does line-segment check for the current blade position
 * 5. Tracks hits per swing to prevent double-damage
 */
export function meleeSwingSystem(world: GameWorld): void {
  const swings = query(world.ecs, [MeleeSwing, Position]);
  const { position, meleeSwing, team, health } = world.stores;
  const hitDistSq = BLADE_HIT_HALF_WIDTH * BLADE_HIT_HALF_WIDTH;

  for (const eid of swings) {
    if (eid === undefined || !entityExists(world.ecs, eid)) continue;

    // Follow owner position
    if (hasComponent(world.ecs, eid, Owner)) {
      const ownerEid = world.stores.owner.eid[eid] ?? 0;
      if (entityExists(world.ecs, ownerEid) && hasComponent(world.ecs, ownerEid, Position)) {
        position.x[eid] = position.x[ownerEid] ?? 0;
        position.y[eid] = position.y[ownerEid] ?? 0;
      }
    }

    const px = position.x[eid] ?? 0;
    const py = position.y[eid] ?? 0;
    const bladeLength = meleeSwing.bladeLength[eid] ?? 0;
    const arcCenter = meleeSwing.arcCenterRad[eid] ?? 0;
    const arcHalf = meleeSwing.arcHalfRad[eid] ?? 0;
    const damage = meleeSwing.damage[eid] ?? 0;
    const spawnAt = meleeSwing.spawnAtMs[eid] ?? 0;
    const duration = meleeSwing.durationMs[eid] ?? 1;
    const swingTeam = hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (world.stores.owner.eid[eid] ?? 0) : -1;

    // Compute sweep progress and current blade angle
    const elapsed = world.elapsedMs - spawnAt;
    const progress = Math.min(1, Math.max(0, elapsed / duration));
    const startAngle = arcCenter + arcHalf;
    const endAngle = arcCenter - arcHalf;
    const currentAngle = startAngle + (endAngle - startAngle) * progress;

    // Blade tip for line-segment check
    const tipX = px + Math.cos(currentAngle) * bladeLength;
    const tipY = py + Math.sin(currentAngle) * bladeLength;

    const hitSet = getHitSet(world, eid);

    // Check all Health entities for blade line-segment collision
    const targets = query(world.ecs, [Health, Position]);
    for (const target of targets) {
      if (target === undefined || target === eid || target === ownerEid) continue;
      if (!entityExists(world.ecs, target)) continue;
      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player)) continue;
      if (swingTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if ((team.id[target] ?? 0) === swingTeam) continue;
      }
      if (hitSet.has(target)) continue;

      const segDist = pointToSegmentDistSq(
        position.x[target] ?? 0, position.y[target] ?? 0,
        px, py, tipX, tipY,
      );

      if (segDist <= hitDistSq) {
        const current = health.current[target] ?? 0;
        health.current[target] = Math.max(0, current - damage);
        hitSet.add(target);
      }
    }
  }
}
