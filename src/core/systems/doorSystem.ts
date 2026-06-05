/**
 * Door System — syncs DoorState component to tile flags.
 *
 * When a door entity's isOpen changes, this system updates the
 * corresponding tile in the FloorMap. Opening a door flips the
 * PASSABLE + TRANSPARENT bits; the FOV system naturally adapts
 * on the next frame.
 *
 * Must run BEFORE fovSystem each frame.
 */

import { query } from 'bitecs';
import { DoorState } from '../components.js';
import type { GameWorld } from '../world.js';

export function doorSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const doors = query(world.ecs, [DoorState]);
  const { doorState } = world.stores;

  for (const eid of doors) {
    if (eid === undefined) continue;

    const tx = doorState.tileX[eid] ?? 0;
    const ty = doorState.tileY[eid] ?? 0;
    const isOpen = (doorState.isOpen[eid] ?? 0) !== 0;

    if (isOpen) {
      floorMap.tileMap.openDoor(tx, ty);
    } else {
      floorMap.tileMap.closeDoor(tx, ty);
    }
  }
}
