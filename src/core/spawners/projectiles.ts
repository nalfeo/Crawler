import { addComponent, set } from 'bitecs';
import {
  AoeOnImpact,
  Bouncing,
  Damage,
  EnemyProjectile,
  Lifetime,
  LineDamage,
  Owner,
  Position,
  Projectile,
  Returning,
  Size,
  Sprite,
  Team,
  Velocity,
  Weight,
} from '../components.js';
import { PHYSICS_BODIES, SHAPE_BOX, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { tagAttackEntity } from '../weapon-telemetry.js';
import { tagDamageMeta } from '../damage-meta.js';
import { createEntity } from './entity-core.js';

export function spawnProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  pierce: number = 0,
  maxRange: number = 0,
  weight: number = 1,
  ownerEid?: number,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: vx, y: vy }));
  addComponent(world.ecs, eid, set(Damage, { amount: damage, cooldownMs: 0, lastFireMs: 0 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0.75, height: 0.75 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['projectile-bullet'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Projectile, { pierce, hitCount: 0, maxRange, originX: x, originY: y }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  if (ownerEid !== undefined) {
    addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  }

  tagAttackEntity(world, eid);
  return eid;
}

export function spawnEnemyProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  ownerEid?: number,
): number {
  // Thread the firing enemy through as Owner so a hit on the player records the
  // shooter (not the transient projectile eid, which is destroyed on impact) as
  // the attacker — Floor 2 Slice 3 ally-defend retaliation targets the shooter.
  const eid = spawnProjectile(world, x, y, vx, vy, damage, 0, 0, 1, ownerEid);
  addComponent(world.ecs, eid, EnemyProjectile);
  // Enemy-sourced damage never scales/crits (see apply-damage.ts) — tagged
  // explicitly (rather than left fail-closed/environment) so it stays correct
  // if this ever needs enemy-specific scaling down the line.
  tagDamageMeta(world, eid, {
    origin: 'enemy',
    affinity: 'unscaled',
    scaleWithPrimary: false,
    canCrit: false,
  });
  // Snapshot the shooter's archetype identity while it is still live.
  // `Owner.eid` persists on the projectile but the shooter can be reaped before
  // impact; `clearEntityStores` removes its appearance key at that point, making
  // a hit-time lookup return `undefined` or the wrong recycled archetype.
  // Storing the snapshot here guarantees `damageTakenBySource` attribution is
  // correct even when the projectile outlives its shooter.
  if (ownerEid !== undefined) {
    const archetypeKey =
      world.enemyAppearanceKeys.get(ownerEid) ?? world.floorScenario?.enemyArchetypes.get(ownerEid);
    if (archetypeKey !== undefined) {
      world.enemyProjectileArchetypeKeys.set(eid, archetypeKey);
    }
  }
  return eid;
}

/** Spawn a projectile that explodes into AoE on impact. */
export function spawnAoeProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  aoeRadius: number,
  aoeDamage: number,
  ownerEid: number,
  teamId: number,
  maxRange: number = 0,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, 0, maxRange);
  addComponent(world.ecs, eid, set(AoeOnImpact, { radius: aoeRadius, damage: aoeDamage }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

/** Spawn a returning/boomerang projectile. */
export function spawnReturningProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  ownerEid: number,
  returnSpeed: number,
  maxRange: number,
  teamId: number,
  pierce: number = 0,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, pierce);
  addComponent(
    world.ecs,
    eid,
    set(Returning, {
      returnSpeed,
      isReturning: 0,
      maxRange,
      originX: x,
      originY: y,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

/** Spawn a projectile that can bounce off arena bounds. */
export function spawnBouncingProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  remainingBounces: number,
  pierce: number = 0,
  maxRange: number = 0,
  ownerEid?: number,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, pierce, maxRange, 1, ownerEid);
  addComponent(world.ecs, eid, set(Bouncing, { remainingBounces }));
  return eid;
}

/** Spawn a beam/line-damage entity. */
export function spawnBeam(
  world: GameWorld,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  length: number,
  damage: number,
  durationMs: number,
  tickMs: number,
  ownerEid: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(LineDamage, { dirX, dirY, length, damage, tickMs, lastTickMs: world.elapsedMs - tickMs }),
  );
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: length, height: 0.5 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: 0,
      halfWidth: length * 0.5,
      halfHeight: PHYSICS_BODIES['beam-segment'].halfHeight,
      shape: SHAPE_BOX,
    }),
  );
  return eid;
}
