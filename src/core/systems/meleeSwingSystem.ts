import { addComponent, entityExists, hasComponent, query, set, setComponent } from 'bitecs';
import {
  Enemy,
  Health,
  Knockback,
  MeleeSwing,
  Owner,
  Player,
  Position,
  Team,
} from '../components.js';
import { applyDamage } from '../apply-damage.js';
import type { GameWorld } from '../world.js';
import { MeleeStyle, WeaponType } from '../../shared/constants.js';

/** Half-width of the blade hitbox in pixels. */
const BLADE_HIT_HALF_WIDTH = 12;

/** Distance from a point to a line segment (squared). */
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
 * Supports head/shaft differentiation: head hits deal full damage,
 * shaft hits deal damage * shaftDamageMult. Knockback displaces
 * enemies away from the player on hit.
 */
export function meleeSwingSystem(world: GameWorld): void {
  const swings = query(world.ecs, [MeleeSwing, Position]);
  const { position, meleeSwing, team } = world.stores;
  const hitDistSq = BLADE_HIT_HALF_WIDTH * BLADE_HIT_HALF_WIDTH;
  const storeSize = position.x.length;

  for (const eid of swings) {
    if (!entityExists(world.ecs, eid) || eid >= storeSize) continue;

    // Follow owner position
    if (hasComponent(world.ecs, eid, Owner)) {
      const ownerEid = world.stores.owner.eid[eid]!;
      if (
        ownerEid >= 0 &&
        ownerEid < storeSize &&
        entityExists(world.ecs, ownerEid) &&
        hasComponent(world.ecs, ownerEid, Position)
      ) {
        position.x[eid] = position.x[ownerEid]!;
        position.y[eid] = position.y[ownerEid]!;
      }
    }

    const px = position.x[eid]!;
    const py = position.y[eid]!;
    const bladeLength = meleeSwing.bladeLength[eid]!;
    const arcCenter = meleeSwing.arcCenterRad[eid]!;
    const arcHalf = meleeSwing.arcHalfRad[eid]!;
    const damage = meleeSwing.damage[eid]!;
    const spawnAt = meleeSwing.spawnAtMs[eid]!;
    const duration = meleeSwing.durationMs[eid]!;
    const style = meleeSwing.style[eid]!;
    const headRadius = meleeSwing.headRadius[eid]!;
    const shaftDamageMult = meleeSwing.shaftDamageMult[eid]!;
    const knockback = meleeSwing.knockback[eid]!;
    const swingTeam = hasComponent(world.ecs, eid, Team) ? team.id[eid]! : -1;
    const ownerEid = hasComponent(world.ecs, eid, Owner) ? world.stores.owner.eid[eid]! : -1;

    const elapsed = world.elapsedMs - spawnAt;
    const progress = Math.min(1, Math.max(0, elapsed / duration));

    let tipX: number;
    let tipY: number;

    if (style === MeleeStyle.STAB) {
      const reach =
        progress <= 0.5 ? (progress / 0.5) * bladeLength : ((1 - progress) / 0.5) * bladeLength;
      tipX = px + Math.cos(arcCenter) * reach;
      tipY = py + Math.sin(arcCenter) * reach;
    } else {
      const startAngle = arcCenter + arcHalf;
      const endAngle = arcCenter - arcHalf;
      const currentAngle = startAngle + (endAngle - startAngle) * progress;
      tipX = px + Math.cos(currentAngle) * bladeLength;
      tipY = py + Math.sin(currentAngle) * bladeLength;
    }

    const hitSet = getHitSet(world, eid);
    const headRadiusSq = headRadius * headRadius;

    // Check all Health entities for collision
    const targets = query(world.ecs, [Health, Position]);
    for (const target of targets) {
      if (target >= storeSize || target === eid || target === ownerEid) continue;
      if (!entityExists(world.ecs, target)) continue;
      if (!hasComponent(world.ecs, target, Enemy) && !hasComponent(world.ecs, target, Player))
        continue;
      if (swingTeam >= 0 && hasComponent(world.ecs, target, Team)) {
        if (target < team.id.length && team.id[target] === swingTeam) continue;
      }
      if (hitSet.has(target)) continue;

      const tx = position.x[target]!;
      const ty = position.y[target]!;

      // Check head hit first (circle around tip)
      let hitDamage = 0;
      if (headRadius > 0) {
        const dxHead = tx - tipX;
        const dyHead = ty - tipY;
        const headDistSq = dxHead * dxHead + dyHead * dyHead;
        if (headDistSq <= headRadiusSq) {
          hitDamage = damage;
        }
      }

      // If no head hit, check shaft hit (line segment)
      if (hitDamage === 0) {
        const segDist = pointToSegmentDistSq(tx, ty, px, py, tipX, tipY);
        if (segDist <= hitDistSq) {
          hitDamage = damage * shaftDamageMult;
        }
      }

      if (hitDamage > 0) {
        applyDamage(world, target, hitDamage, tx, ty, undefined, px, py, WeaponType.MELEE);
        hitSet.add(target);

        // Apply knockback as smooth impulse via Knockback component
        if (knockback > 0) {
          const kbDx = tx - px;
          const kbDy = ty - py;
          const kbDist = Math.hypot(kbDx, kbDy);
          if (kbDist > 0.001) {
            const nx = kbDx / kbDist;
            const ny = kbDy / kbDist;
            // Spread the knockback over ~10 frames for smooth motion
            const kbSpeed = Math.max(1, knockback / 10);
            if (hasComponent(world.ecs, target, Knockback)) {
              setComponent(world.ecs, target, Knockback, {
                dirX: nx,
                dirY: ny,
                remaining: knockback,
                speed: kbSpeed,
              });
            } else {
              addComponent(
                world.ecs,
                target,
                set(Knockback, {
                  dirX: nx,
                  dirY: ny,
                  remaining: knockback,
                  speed: kbSpeed,
                }),
              );
            }
          }
        }
      }
    }
  }
}
