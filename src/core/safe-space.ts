import type { GameWorld } from './world.js';
import { RoomRole } from '../shared/map-types.js';

/**
 * Returns true when the given pixel position is inside any safe room on the current floor.
 * Floors without a safe room report false.
 */
export function isPointInSafeSpace(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) return false;
  const safeRooms = floorMap.roomGraph.getRoomsByRole(RoomRole.SAFE);
  if (safeRooms.length === 0) return false;
  const tile = floorMap.pixelToTile(x, y);
  return safeRooms.some(({ bounds: { x: rx, y: ry, width, height } }) => {
    return tile.x >= rx && tile.x < rx + width && tile.y >= ry && tile.y < ry + height;
  });
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
