import { entityExists, hasComponent, query } from 'bitecs';
import { Enemy, Health, Homing, Position, Velocity } from '../components.js';
import type { GameWorld } from '../world.js';

const TWO_PI = Math.PI * 2;

/** Normalize an angle delta to the shortest signed turn, in (-PI, PI]. */
function normalizeAngleDelta(deltaRad: number): number {
  let normalized = deltaRad % TWO_PI;
  if (normalized > Math.PI) normalized -= TWO_PI;
  if (normalized < -Math.PI) normalized += TWO_PI;
  return normalized;
}

/**
 * Steers `Homing` projectiles (currently only Magic Missile — issue #3248)
 * toward their stored target, once their arc-out delay has elapsed.
 *
 * Before `activateFrame`, a homing projectile keeps whatever velocity it was
 * spawned with untouched — this is the visible "arc out from the caster"
 * launch phase. Once active, its heading rotates toward the live target
 * position by at most `turnRateRadPerFrame` per tick (never snapping), so the
 * missile visibly curves in rather than teleporting onto a beeline. Speed is
 * held constant so the curve is a pure rotation, not an acceleration.
 *
 * Runs before `movementSystem` so the rotated velocity is what actually moves
 * the projectile this tick.
 */
export function homingSystem(world: GameWorld): void {
  const entities = query(world.ecs, [Homing, Position, Velocity]);
  const { position, velocity, homing } = world.stores;

  for (const eid of entities) {
    if (!entityExists(world.ecs, eid)) continue;
    if (world.frameCount < (homing.activateFrame[eid] ?? 0)) continue;

    const targetEid = homing.targetEid[eid] ?? 0;
    if (
      !entityExists(world.ecs, targetEid) ||
      !hasComponent(world.ecs, targetEid, Enemy) ||
      !hasComponent(world.ecs, targetEid, Health) ||
      (world.stores.health.current[targetEid] ?? 0) <= 0
    ) {
      // Target is gone or dead: keep flying the current heading. Range/wall
      // cleanup (`projectileCleanupSystem`) despawns it eventually.
      continue;
    }

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const dx = (position.x[targetEid] ?? 0) - x;
    const dy = (position.y[targetEid] ?? 0) - y;
    if (dx === 0 && dy === 0) continue;

    const vx = velocity.x[eid] ?? 0;
    const vy = velocity.y[eid] ?? 0;
    const speed = homing.speed[eid] || Math.hypot(vx, vy);
    if (speed <= 0) continue;

    const currentAngle = Math.atan2(vy, vx);
    const desiredAngle = Math.atan2(dy, dx);
    const maxTurn = Math.max(0, homing.turnRateRadPerFrame[eid] ?? 0);
    const deltaAngle = normalizeAngleDelta(desiredAngle - currentAngle);
    const clampedDelta = Math.max(-maxTurn, Math.min(maxTurn, deltaAngle));
    const newAngle = currentAngle + clampedDelta;

    velocity.x[eid] = Math.cos(newAngle) * speed;
    velocity.y[eid] = Math.sin(newAngle) * speed;
  }
}
