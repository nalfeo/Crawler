import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { Companion, DoorState, Position } from '../../src/core/components.js';
import { makeMapWithSafeRoomDoor } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { TeamId } from '../../src/shared/constants.js';

/** Spawns a Companion at a tile centre on `ownerTeam`'s roster. */
function spawnCompanionAt(
  world: ReturnType<typeof createTestWorld>,
  tileX: number,
  tileY: number,
  ownerTeam: number,
): number {
  const eid = addEntity(world.ecs);
  addComponent(
    world.ecs,
    eid,
    set(Companion, {
      speciesToken: 1,
      form: 0,
      level: 1,
      xp: 0,
      ownerTeam,
      knockedOut: 0,
    }),
  );
  addComponent(world.ecs, eid, set(Position, { x: tileX * 32 + 16, y: tileY * 32 + 16 }));
  return eid;
}

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

  it('keeps the doorway open while a player-owned companion is adjacent to the safe-room door', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);
    spawnCompanionAt(world, 3, 2, TeamId.PLAYER);

    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 3, tileY: 3, logicalOpen: 1, isLocked: 0 }),
    );

    doorSystem(world);

    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(true);
    expect(world.stores.doorState.effectiveOpen[door]).toBe(1);
  });

  it('still seals the safe room when only a rival roster companion is in the doorway', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player inside the safe room but away from the doorway; the only actor on
    // the threshold belongs to a rival Floor 3 roster, so it must not count.
    spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);
    spawnCompanionAt(world, 3, 2, TeamId.ENEMY);

    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 3, tileY: 3, logicalOpen: 1, isLocked: 0 }),
    );

    doorSystem(world);

    expect(world.stores.doorState.effectiveOpen[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(3, 3)).toBe(false);
  });
});

describe('doorSystem companion auto-open (Floor 3)', () => {
  it('opens a closed door for a player-owned companion when the player is out of range', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    world.floorMap = makeMapWithSafeRoomDoor();
    // Floor 3 disables safe-room auto-close, so only the companion auto-open
    // pass can open the raw closed door at (3,3). The player stands far away.
    spawnPlayer(world, 9 * 32 + 16, 9 * 32 + 16);
    spawnCompanionAt(world, 3, 2, TeamId.PLAYER);

    expect(world.floorMap.tileMap.isPassable(3, 3)).toBe(false);

    doorSystem(world);

    expect(world.floorMap.tileMap.isPassable(3, 3)).toBe(true);
  });

  it('leaves the door closed for a rival roster companion', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    world.floorMap = makeMapWithSafeRoomDoor();
    spawnPlayer(world, 9 * 32 + 16, 9 * 32 + 16);
    spawnCompanionAt(world, 3, 2, TeamId.ENEMY);

    doorSystem(world);

    expect(world.floorMap.tileMap.isPassable(3, 3)).toBe(false);
  });

  it('leaves the door closed for a knocked-out player companion', () => {
    const world = createTestWorld({ floor: 3 });
    world.floorId = 'floor3';
    world.floorMap = makeMapWithSafeRoomDoor();
    spawnPlayer(world, 9 * 32 + 16, 9 * 32 + 16);
    const companion = spawnCompanionAt(world, 3, 2, TeamId.PLAYER);
    world.stores.companion.knockedOut[companion] = 1;

    doorSystem(world);

    expect(world.floorMap.tileMap.isPassable(3, 3)).toBe(false);
  });
});
