import { addComponent, addEntity, set } from 'bitecs';
import { createInventoryBag } from '../shared/inventory.js';
import {
  Damage,
  Enemy,
  EnemyBehavior,
  EnemyProjectile,
  Health,
  Inventory,
  Player,
  Position,
  Projectile,
  Sprite,
  Velocity,
  XpGem,
  DroppedItem,
} from './components.js';
import type { GameWorld } from './world.js';

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
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: vx, y: vy }));
  addComponent(world.ecs, eid, set(Damage, { amount: damage, cooldownMs: 0, lastFireMs: 0 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 6, height: 6 }));
  addComponent(world.ecs, eid, Projectile);

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

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(DroppedItem, { itemIndex }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 10, height: 10 }));

  return eid;
}
