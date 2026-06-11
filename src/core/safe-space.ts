import type { GameWorld } from './world.js';

/**
 * Returns true when the given pixel position is inside the current floor's safe-room bounds.
 * Floors without a discrete safe room report false.
 */
export function isPointInSafeSpace(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  const safeRoom = floorMap?.safeRoom;
  if (!floorMap || !safeRoom) {
    return false;
  }

  const tile = floorMap.pixelToTile(x, y);
  const { x: roomX, y: roomY, width, height } = safeRoom.bounds;
  return tile.x >= roomX && tile.x < roomX + width && tile.y >= roomY && tile.y < roomY + height;
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
