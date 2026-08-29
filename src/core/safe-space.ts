import { query } from 'bitecs';
import type { GameWorld } from './world.js';
import { RoomRole, type RoomData } from '../shared/map-types.js';
import { GAME } from '../shared/constants.js';
import { Player } from './components.js';
import { getWorldFloorBehavior } from './floor-behavior.js';
import { isFloorTimerPaused } from './floor-timer.js';

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
 * Authored safe space: an entrance room the floor declares safe
 * (`behavior.spawnRoomIsSafe`) or a room generated with `RoomRole.SAFE`.
 *
 * This is the subset that exists on the map before the run starts, which is
 * exactly the subset that stops the floor timer — see
 * {@link isPointInTimeStoppingSafeSpace}.
 */
function isPointInAuthoredSafeSpace(world: GameWorld, tx: number, ty: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  if (getWorldFloorBehavior(world).spawnRoomIsSafe) {
    const entranceRoom = floorMap.spawnRoom;
    if (entranceRoom && roomContainsTile(entranceRoom, tx, ty)) {
      return true;
    }
  }
  const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
  if (safeRooms.length === 0) return false;
  return safeRooms.some((room) => roomContainsTile(room, tx, ty));
}

/**
 * Returns true when the given world position (feet) is inside any safe room on the current floor.
 * Floors without a safe room report false.
 */
export function isPointInSafeSpace(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  const tile = floorMap.worldToTile(x, y);
  // Positions outside the map are never safe. Guarding here also prevents the
  // flattened hallway index (`ty * width + tx`) from aliasing an out-of-bounds
  // tile onto a real hallway tile on an adjacent row.
  if (tile.x < 0 || tile.y < 0 || tile.x >= floorMap.width || tile.y >= floorMap.height) {
    return false;
  }
  // Internal settlement connectors are only safe once the settlement has been
  // initialized for the run — see `floor2Settlement`.
  const settlement = world.floorExtendedState?.settlement;
  if (settlement && floorMap.settlementHallwayTileIndices.has(tile.y * floorMap.width + tile.x)) {
    return true;
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
  return isPointInAuthoredSafeSpace(world, tile.x, tile.y);
}

/**
 * Returns true when the position is inside a safe room that stops the floor's
 * collapse timer.
 *
 * This is deliberately narrower than {@link isPointInSafeSpace}: a boss arena
 * that turned safe when its boss died (`world.clearedSafeRoomIds`) still grants
 * every other safe-room affordance — customization panels, spawn suppression,
 * weapon immunity — but must **not** stop the countdown, or a cleared arena
 * becomes an unlimited parking spot for the rest of the floor.
 */
export function isPointInTimeStoppingSafeSpace(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  const tile = floorMap.worldToTile(x, y);
  return isPointInAuthoredSafeSpace(world, tile.x, tile.y);
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
 *
 * Also maintains the floor-timer pause: while the player stands in a
 * time-stopping safe space on a floor that opted in
 * (`behavior.safeRoomPausesFloorTimer`), one tick's worth of credit is banked in
 * `world.safeRoomTimerCreditMs`. Every floor-collapse consumer (the floor
 * scenarios, the HUD countdown and the AI's collapse planning) resolves its
 * deadline through that single credit, so they can never disagree.
 */
export function safeRoomSystem(world: GameWorld): void {
  if (world.state !== 'playing') {
    return;
  }
  const players = query(world.ecs, [Player]);
  const playerEid = players[0];
  if (playerEid === undefined) {
    world.playerInSafeRoom = false;
    world.playerInTimeStoppingSafeRoom = false;
    return;
  }
  world.playerInSafeRoom = isEntityInSafeSpace(world, playerEid);
  const x = world.stores.position.x[playerEid];
  const y = world.stores.position.y[playerEid];
  world.playerInTimeStoppingSafeRoom =
    x !== undefined && y !== undefined && isPointInTimeStoppingSafeSpace(world, x, y);
  if (world.playerInTimeStoppingSafeRoom) {
    world.safeRoomElapsedMs += GAME.DELTA_MS;
  }
  if (isFloorTimerPaused(world)) {
    world.safeRoomTimerCreditMs += GAME.DELTA_MS;
  }
}
