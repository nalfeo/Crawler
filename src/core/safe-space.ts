import { query } from 'bitecs';
import type { GameWorld } from './world.js';
import { RoomRole, type RoomData } from '../shared/map-types.js';
import { Player } from './components.js';
import { getWorldFloorBehavior } from './floor-behavior.js';

function roomContainsTile(room: RoomData, tx: number, ty: number): boolean {
  if (room.interiorCells && room.interiorCells.length > 0) {
    return room.interiorCells.some((cell) => cell.x === tx && cell.y === ty);
  }
  const {
    bounds: { x, y, width, height },
  } = room;
  return tx >= x && tx < x + width && ty >= y && ty < y + height;
}

/**
 * Returns true when the given world position (feet) is inside any safe room on the current floor.
 * Floors without a safe room report false.
 */
export function isPointInSafeSpace(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  const tile = floorMap.worldToTile(x, y);
  if (getWorldFloorBehavior(world).spawnRoomIsSafe) {
    const entranceRoom = floorMap.spawnRoom;
    if (entranceRoom && roomContainsTile(entranceRoom, tile.x, tile.y)) {
      return true;
    }
  }
  // Rooms that became safe during the run (a cleared boss arena) are safe on
  // top of the authored SAFE rooms. Resolved by room id because the cleared
  // room keeps its generated role — see `GameWorld.clearedSafeRoomIds`. Ids are
  // per-floor, so they only apply to the map they were recorded against.
  if (world.clearedSafeRoomIds.size > 0 && world.clearedSafeRoomMap === floorMap) {
    const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
    if (roomId >= 0 && world.clearedSafeRoomIds.has(roomId)) {
      return true;
    }
  }
  const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
  if (safeRooms.length === 0) return false;
  return safeRooms.some((room) => roomContainsTile(room, tile.x, tile.y));
}

/** Returns true when the entity's current position is inside a safe room. */
export function isEntityInSafeSpace(world: GameWorld, eid: number): boolean {
  const x = world.stores.position.x[eid];
  const y = world.stores.position.y[eid];
  if (x === undefined || y === undefined) {
    return false;
  }
  return isPointInSafeSpace(world, x, y);
}

/**
 * Returns true when customization systems (equipment, inventory, skills) should
 * be enabled for the player. This covers two cases:
 *
 *  - `world.playerInSafeRoom` — player is physically inside a safe room during
 *    active gameplay (the common in-run case).
 *  - `world.state === 'safe_room'` — the run has ended (floor cleared); the
 *    player reviews stats and gear before transitioning.
 *
 * Always pair with a feature-unlock check: a system is only usable if
 * `isInSafeContext(world) && world.featureUnlocks.<system>`.
 */
export function isInSafeContext(world: GameWorld): boolean {
  return world.playerInSafeRoom || world.state === 'safe_room';
}

/**
 * ECS system — updates `world.playerInSafeRoom` based on the player's current
 * position.  Must run each tick after `movementSystem` so positions are
 * current.  Only meaningful during active gameplay (`state === 'playing'`).
 */
export function safeRoomSystem(world: GameWorld): void {
  if (world.state !== 'playing') {
    return;
  }
  const players = query(world.ecs, [Player]);
  const playerEid = players[0];
  if (playerEid === undefined) {
    world.playerInSafeRoom = false;
    return;
  }
  world.playerInSafeRoom = isEntityInSafeSpace(world, playerEid);
}
