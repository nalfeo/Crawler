import { hasComponent, query, removeComponent } from 'bitecs';
import { Flying, Knockback, Position } from '../components.js';
import type { GameWorld } from '../world.js';

// Sample just inside an entity's footprint so exact tile-edge contact does not
// read as a wall hit because of floating-point rounding.
const COLLISION_EPSILON = 0.001;

// Knockback is resolved in fixed-size substeps so a fast slide cannot tunnel
// through a thin wall. The substep length is the spatial resolution of that
// sweep; ~1px keeps wall contact crisp. Expressed in feet (the canonical unit)
// so the substep count scales with the move distance independent of render px.
const KNOCKBACK_SUBSTEP_FT = 0.125;

function isFootprintPassable(world: GameWorld, eid: number, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }

  const width = world.stores.sprite.width[eid] ?? 0;
  const height = world.stores.sprite.height[eid] ?? 0;
  // Small bodies (≤ half a tile) already match the historic center-point rule.
  // Tighten the check only for larger sprites such as the Floor 1 boss, whose
  // footprint can overlap a wall before its center crosses into the blocked tile.
  // Zero/near-zero dimensions also fall back to the center point; knockback in
  // this codebase targets creature-sized sprites, not projectile footprints.
  const tileSizeFt = floorMap.config.tileSizeFt;
  if (
    width <= COLLISION_EPSILON * 2 ||
    height <= COLLISION_EPSILON * 2 ||
    (width <= tileSizeFt * 0.5 && height <= tileSizeFt * 0.5)
  ) {
    return floorMap.isPassableAt(x, y);
  }

  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const left = x - halfWidth + COLLISION_EPSILON;
  const right = x + halfWidth - COLLISION_EPSILON;
  const top = y - halfHeight + COLLISION_EPSILON;
  const bottom = y + halfHeight - COLLISION_EPSILON;

  return (
    floorMap.isPassableAt(left, top) &&
    floorMap.isPassableAt(right, top) &&
    floorMap.isPassableAt(left, bottom) &&
    floorMap.isPassableAt(right, bottom)
  );
}

/**
 * Knockback system — smoothly displaces entities each frame.
 *
 * Each frame, moves the entity by (dirX * speed, dirY * speed) and
 * decrements `remaining` by `speed`. When remaining <= 0, the
 * Knockback component is removed.
 *
 * Also records `world.maxKnockbackStepThisFrame` — the max REALIZED (post-clamp)
 * displacement of any entity this frame — so `beamSystem` (which runs after this
 * system, against the pre-knockback collision grid) can inflate its broad-phase
 * radius to still find targets the grid indexed at a now-stale position. Measured
 * from the actually-written position so the bound is writer-agnostic and correct
 * even when a wall/flying-bounds clamp reduces the move.
 */
export function knockbackSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Knockback, Position]);
  const { position, knockback } = world.stores;
  const floorMap = world.floorMap;
  world.maxKnockbackStepThisFrame = 0;

  for (const eid of entities) {
    if (eid === undefined) continue;

    const remaining = knockback.remaining[eid] ?? 0;
    const speed = knockback.speed[eid] ?? 0;

    if (remaining <= 0 || speed <= 0) {
      removeComponent(world.ecs, eid, Knockback);
      continue;
    }

    const step = Math.min(speed, remaining);
    const dirX = knockback.dirX[eid] ?? 0;
    const dirY = knockback.dirY[eid] ?? 0;
    const oldX = position.x[eid] ?? 0;
    const oldY = position.y[eid] ?? 0;
    let currentX = oldX;
    let currentY = oldY;

    if (floorMap) {
      const isFlying = hasComponent(world.ecs, eid, Flying);
      if (isFlying) {
        const newX = oldX + dirX * step;
        const newY = oldY + dirY * step;
        const inBoundsX = newX >= 0 && newX < floorMap.widthFt;
        const inBoundsY = newY >= 0 && newY < floorMap.heightFt;

        if (inBoundsX) {
          position.x[eid] = newX;
        }
        if (inBoundsY) {
          position.y[eid] = newY;
        }
      } else {
        const substepCount = Math.max(1, Math.ceil(step / KNOCKBACK_SUBSTEP_FT));
        const substep = step / substepCount;

        for (let i = 0; i < substepCount; i += 1) {
          const nextX = currentX + dirX * substep;
          const nextY = currentY + dirY * substep;

          if (isFootprintPassable(world, eid, nextX, nextY)) {
            currentX = nextX;
            currentY = nextY;
          } else if (isFootprintPassable(world, eid, nextX, currentY)) {
            currentX = nextX;
          } else if (isFootprintPassable(world, eid, currentX, nextY)) {
            currentY = nextY;
          } else {
            break;
          }
        }

        position.x[eid] = currentX;
        position.y[eid] = currentY;
      }
    } else {
      position.x[eid] = oldX + dirX * step;
      position.y[eid] = oldY + dirY * step;
    }

    // Record the max realized displacement (post-clamp) so beamSystem can bound
    // its stale-grid broad-phase radius. Reading the written position — rather
    // than `step` or the commanded (dirX,dirY)*step — makes this correct
    // regardless of the writer's dir magnitude or any wall/bounds clamp above.
    const finalX = position.x[eid] ?? oldX;
    const finalY = position.y[eid] ?? oldY;
    const realized = Math.hypot(finalX - oldX, finalY - oldY);
    if (realized > world.maxKnockbackStepThisFrame) {
      world.maxKnockbackStepThisFrame = realized;
    }

    knockback.remaining[eid] = remaining - step;

    if (remaining - step <= 0) {
      removeComponent(world.ecs, eid, Knockback);
    }
  }
}
