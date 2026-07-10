import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { DoorState } from '../../src/core/components.js';
import { makeMapWithSafeRoomDoor } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('doorSystem safe-room forced-close behaviour', () => {
  it('forces safe-room doors closed when the player is inside but not in the doorway', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player at tile (2,2) → world centre (80, 80) ft, inside the safe room.
    spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);

    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 3, tileY: 3, logicalOpen: 1, isLocked: 0 }),
    );

    doorSystem(world);

    // Decoupled authority model: the safe-room seal closes the TILE (effectiveOpen
    // + physical passability) but never clobbers the logicalOpen LATCH. This is the
    // structural fix — the old code asserted logicalOpen===0 here, encoding the very
    // coupling that permanently sealed a shared safe-room / boss-stair door.
    expect(world.stores.doorState.logicalOpen[door]).toBe(1);
    expect(world.stores.doorState.effectiveOpen[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(false);
  });

  it('keeps the doorway open while the player stands adjacent to a safe-room door', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player at tile (3,2) → adjacent (manhattan 1) to the door at (3,3).
    spawnPlayer(world, 3 * 32 + 16, 2 * 32 + 16);

    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 3, tileY: 3, logicalOpen: 1, isLocked: 0 }),
    );

    doorSystem(world);

    // The doorway guard keeps the safe-room door open (not forced closed).
    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(true);
    expect(world.stores.doorState.effectiveOpen[door]).toBe(1);
  });
});
