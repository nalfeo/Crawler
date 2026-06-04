import { addComponent, addEntity, set } from 'bitecs';
import { createInventoryBag } from '../shared/inventory.js';
import {
  AoeOnImpact,
  AreaDamage,
  Damage,
  Enemy,
  EnemyBehavior,
  EnemyProjectile,
  Health,
  Inventory,
  Lifetime,
  LineDamage,
  MeleeSwing,
  Owner,
  Player,
  Position,
  Projectile,
  Returning,
  Sprite,
  Team,
  Trap,
  Velocity,
  Weapon,
  XpGem,
  DroppedItem,
} from './components.js';
import type { GameWorld } from './world.js';
import type { WeaponTypeValue } from '../shared/constants.js';
import { clearAreaDamageHits } from './systems/areaDamageSystem.js';
import { clearMeleeSwingHits } from './systems/meleeSwingSystem.js';

/** Zero all typed-array store slots for a recycled entity ID. */
export function clearEntityStores(world: GameWorld, eid: number): void {
  const { stores } = world;
  for (const group of Object.values(stores)) {
    for (const arr of Object.values(group as Record<string, ArrayLike<number>>)) {
      if (arr instanceof Float32Array || arr instanceof Uint16Array || arr instanceof Uint8Array) {
        arr[eid] = 0;
      }
    }
  }
}

/** Create an entity with zeroed store slots (safe against ID recycling). */
export function createEntity(world: GameWorld): number {
  const eid = addEntity(world.ecs);
  clearEntityStores(world, eid);
  return eid;
}

export function spawnPlayer(world: GameWorld, x: number, y: number): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 24, height: 24 }));
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, Inventory);
  world.inventories.set(eid, createInventoryBag());

  return eid;
}

export function spawnEnemy(world: GameWorld, x: number, y: number, hp: number): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
  addComponent(world.ecs, eid, Enemy);

  return eid;
}

export function spawnBehaviorEnemy(
  world: GameWorld,
  x: number,
  y: number,
  hp: number,
  behaviorType: number,
  speed: number,
  aggroRange: number,
  attackRange: number,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(EnemyBehavior, { type: behaviorType, speed, aggroRange, attackRange }),
  );

  return eid;
}

export function spawnXpGem(world: GameWorld, x: number, y: number, value: number): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(XpGem, { value }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));

  return eid;
}

export function spawnProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  pierce: number = 0,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: vx, y: vy }));
  addComponent(world.ecs, eid, set(Damage, { amount: damage, cooldownMs: 0, lastFireMs: 0 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 6, height: 6 }));
  addComponent(world.ecs, eid, set(Projectile, { pierce, hitCount: 0 }));

  return eid;
}

export function spawnEnemyProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage);
  addComponent(world.ecs, eid, EnemyProjectile);
  return eid;
}

export function spawnDroppedItem(
  world: GameWorld,
  x: number,
  y: number,
  itemIndex: number,
): number {
  const eid = createEntity(world);
  const sanitizedItemIndex = Math.max(0, Math.min(0xffff, Math.floor(itemIndex)));

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(DroppedItem, { itemIndex: sanitizedItemIndex }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 10, height: 10 }));
  
  return eid;
}

/** Spawn a weapon entity attached to an owner. */
export function spawnWeapon(
  world: GameWorld,
  ownerEid: number,
  weaponType: WeaponTypeValue,
  baseDamage: number,
  cooldownMs: number,
  range: number,
  projectileSpeed: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(
    world.ecs,
    eid,
    set(Weapon, {
      weaponType,
      baseDamage,
      cooldownMs,
      lastFireMs: -cooldownMs,
      range,
      projectileSpeed,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

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
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage);
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
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: length, height: 4 }));
  return eid;
}

/** Spawn a trap entity at a position. */
export function spawnTrap(
  world: GameWorld,
  x: number,
  y: number,
  explosionDamage: number,
  triggerRadius: number,
  explosionRadius: number,
  armDelayMs: number,
  ownerEid: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Trap, {
      triggerRadius,
      explosionRadius,
      explosionDamage,
      armAtMs: world.elapsedMs + armDelayMs,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 12, height: 12 }));
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
  return eid;
}
