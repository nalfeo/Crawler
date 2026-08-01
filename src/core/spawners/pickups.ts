import { addComponent, set } from 'bitecs';
import { DroppedItem, Gold, Position, Size, Sprite, Weight, XpGem } from '../components.js';
import { PHYSICS_BODIES, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { recordSpawnedXp } from '../xp-collection-telemetry.js';
import { createEntity } from './entity-core.js';

export function spawnXpGem(
  world: GameWorld,
  x: number,
  y: number,
  value: number,
  weight = 1,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(XpGem, { value }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1, height: 1 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['xp-gem'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  recordSpawnedXp(world, value);

  return eid;
}

export function spawnGold(
  world: GameWorld,
  x: number,
  y: number,
  value: number,
  weight = 1,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Gold, { value }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1, height: 1 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES.gold.radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));

  return eid;
}

export function spawnDroppedItem(
  world: GameWorld,
  x: number,
  y: number,
  itemIndex: number,
  weight = 5,
): number {
  const eid = createEntity(world);
  const sanitizedItemIndex = Math.max(0, Math.min(0xffff, Math.floor(itemIndex)));

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(DroppedItem, { itemIndex: sanitizedItemIndex }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1.25, height: 1.25 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['dropped-item'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));

  return eid;
}
