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
import { DoorState, Player, Position } from '../components.js';
import { evaluateDoorConditionGroup, getDoorLockConfig } from '../door-lock.js';
import type { GameWorld } from '../world.js';

const AUTO_OPEN_RADIUS_TILES = 1;

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function doorSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const doors = query(world.ecs, [DoorState]);
  const { doorState } = world.stores;
  const lockedDoorTiles = new Set<string>();

  // Evaluate lock conditions first so auto-open respects currently locked doors.
  for (const eid of doors) {
    const tx = doorState.tileX[eid] ?? 0;
    const ty = doorState.tileY[eid] ?? 0;
    const wasLocked = (doorState.isLocked[eid] ?? 0) !== 0;
    let isLocked = wasLocked;
    const lockConfig = getDoorLockConfig(world, eid);

    if (lockConfig) {
      const unlockSatisfied = evaluateDoorConditionGroup(world, lockConfig.unlock);
      const relockSatisfied = lockConfig.relock
        ? evaluateDoorConditionGroup(world, lockConfig.relock)
        : false;

      if (wasLocked) {
        if (unlockSatisfied && !relockSatisfied) {
          isLocked = false;
          doorState.wasUnlocked[eid] = 1;
          doorState.isOpen[eid] = 1;
        }
      } else if (relockSatisfied) {
        isLocked = true;
        doorState.isOpen[eid] = 0;
      }
    }

    doorState.isLocked[eid] = isLocked ? 1 : 0;
    if (isLocked) {
      doorState.isOpen[eid] = 0;
      lockedDoorTiles.add(tileKey(tx, ty));
    }
  }

  // Auto-open nearby closed doors so players can traverse room connections.
  const players = query(world.ecs, [Player, Position]);
  for (const player of players) {
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    const tile = floorMap.pixelToTile(px, py);

    for (let dy = -AUTO_OPEN_RADIUS_TILES; dy <= AUTO_OPEN_RADIUS_TILES; dy += 1) {
      for (let dx = -AUTO_OPEN_RADIUS_TILES; dx <= AUTO_OPEN_RADIUS_TILES; dx += 1) {
        const tx = tile.x + dx;
        const ty = tile.y + dy;
        if (!floorMap.tileMap.inBounds(tx, ty) || !floorMap.tileMap.isDoor(tx, ty)) {
          continue;
        }
        if (lockedDoorTiles.has(tileKey(tx, ty))) {
          continue;
        }
        if (!floorMap.tileMap.isPassable(tx, ty)) {
          floorMap.tileMap.openDoor(tx, ty);
        }
      }
    }
  }

  for (const eid of doors) {
    const tx = doorState.tileX[eid] ?? 0;
    const ty = doorState.tileY[eid] ?? 0;
    const isLocked = (doorState.isLocked[eid] ?? 0) !== 0;
    const isOpen = (doorState.isOpen[eid] ?? 0) !== 0;

    if (isLocked) {
      floorMap.tileMap.closeDoor(tx, ty);
    } else if (isOpen) {
      floorMap.tileMap.openDoor(tx, ty);
    } else {
      floorMap.tileMap.closeDoor(tx, ty);
    }
  }
}
