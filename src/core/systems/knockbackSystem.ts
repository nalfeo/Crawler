import { hasComponent, query, removeComponent } from 'bitecs';
import { Flying, Knockback, Position } from '../components.js';
import type { GameWorld } from '../world.js';

const COLLISION_EPSILON = 0.001;

function isFootprintPassable(world: GameWorld, eid: number, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return true;
  }

  const width = world.stores.sprite.width[eid] ?? 0;
  const height = world.stores.sprite.height[eid] ?? 0;
  const tileSizePx = floorMap.config.tileSizePx;
  if (
    width <= COLLISION_EPSILON ||
    height <= COLLISION_EPSILON ||
    (width <= tileSizePx * 0.5 && height <= tileSizePx * 0.5)
  ) {
    return floorMap.isPassableAt(x, y);
  }

  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const left = x - halfWidth + COLLISION_EPSILON;
  const right = x + halfWidth - COLLISION_EPSILON;
  const top = y - halfHeight + COLLISION_EPSILON;
  const bottom = y + halfHeight - COLLISION_EPSILON;
  const sampleLeft = left <= right ? left : x;
  const sampleRight = left <= right ? right : x;
  const sampleTop = top <= bottom ? top : y;
  const sampleBottom = top <= bottom ? bottom : y;

  return (
    floorMap.isPassableAt(sampleLeft, sampleTop) &&
    floorMap.isPassableAt(sampleRight, sampleTop) &&
    floorMap.isPassableAt(sampleLeft, sampleBottom) &&
    floorMap.isPassableAt(sampleRight, sampleBottom)
  );
}

/**
 * Knockback system — smoothly displaces entities each frame.
 *
 * Each frame, moves the entity by (dirX * speed, dirY * speed) and
 * decrements `remaining` by `speed`. When remaining <= 0, the
 * Knockback component is removed.
 */
export function knockbackSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Knockback, Position]);
  const { position, knockback } = world.stores;
  const floorMap = world.floorMap;

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
        const inBoundsX = newX >= 0 && newX < floorMap.widthPx;
        const inBoundsY = newY >= 0 && newY < floorMap.heightPx;

        if (inBoundsX) {
          position.x[eid] = newX;
        }
        if (inBoundsY) {
          position.y[eid] = newY;
        }
      } else {
        const substepCount = Math.max(1, Math.ceil(step));
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

    knockback.remaining[eid] = remaining - step;

    if (remaining - step <= 0) {
      removeComponent(world.ecs, eid, Knockback);
    }
  }
}
