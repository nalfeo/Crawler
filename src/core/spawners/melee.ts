import { addComponent, set } from 'bitecs';
import {
  AreaDamage,
  Lifetime,
  MeleeSwing,
  Owner,
  Position,
  Size,
  Sprite,
  Team,
} from '../components.js';
import { SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { tagAttackEntity } from '../weapon-telemetry.js';
import { clearAreaDamageHits } from '../systems/areaDamageSystem.js';
import { clearMeleeSwingHits } from '../systems/meleeSwingSystem.js';
import { createEntity } from './entity-core.js';

/** Spawn a melee/unarmed area attack at the player's position. */
export function spawnAreaAttack(
  world: GameWorld,
  x: number,
  y: number,
  ownerEid: number,
  damage: number,
  radius: number,
  durationMs: number,
  teamId: number,
  dirX?: number,
  dirY?: number,
  arcDeg?: number,
): number {
  const eid = createEntity(world);
  const hasArc =
    dirX !== undefined && dirY !== undefined && arcDeg !== undefined && arcDeg > 0 && arcDeg < 360;
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(AreaDamage, {
      radius,
      damage,
      hitOnce: 1,
      arcCenterRad: hasArc ? Math.atan2(dirY, dirX) : 0,
      arcHalfRad: hasArc ? (arcDeg / 2) * (Math.PI / 180) : 0,
    }),
  );
  // Clear stale hit tracking in case this entity ID was recycled.
  clearAreaDamageHits(world, eid);
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: radius * 2, height: radius * 2 }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  tagAttackEntity(world, eid);
  return eid;
}

/** Spawn a melee swing entity — a blade that sweeps through an arc or thrusts forward. */
export function spawnMeleeSwing(
  world: GameWorld,
  x: number,
  y: number,
  ownerEid: number,
  damage: number,
  bladeLength: number,
  durationMs: number,
  dirX: number,
  dirY: number,
  arcDeg: number,
  teamId: number,
  style: number = 0,
  headRadius: number = 0,
  shaftDamageMult: number = 1,
  knockback: number = 0,
  spriteId: number = 0,
): number {
  const eid = createEntity(world);
  const arcCenterRad = Math.atan2(dirY, dirX);
  const arcHalfRad = (arcDeg / 2) * (Math.PI / 180);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(MeleeSwing, {
      bladeLength,
      arcCenterRad,
      arcHalfRad,
      damage,
      spawnAtMs: world.elapsedMs,
      durationMs,
      style,
      headRadius,
      shaftDamageMult,
      knockback,
      spriteId,
    }),
  );
  // Clear any stale hit tracking from a recycled entity ID
  clearMeleeSwingHits(world, eid);
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: bladeLength * 2, height: bladeLength * 2 }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: bladeLength,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  tagAttackEntity(world, eid);
  return eid;
}
