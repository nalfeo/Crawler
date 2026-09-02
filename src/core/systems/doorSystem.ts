/**
 * Door System — reconciles DoorState into tile flags.
 *
 * A door carries two independent bits of open state:
 *   - `logicalOpen`  — the intended-open LATCH. Written only by lock/unlock and
 *     floor/encounter authorities: the door-lock evaluator below (unlock edge → 1,
 *     relock/locked → 0), plus floor objective / boss transitions and spawner
 *     arenas (e.g. floorScenario.ts, floor2Scenario.ts, spawnerArenaSystem.ts).
 *     The safe-room seal / physical reconcile never touches it.
 *   - `effectiveOpen` — the physical/tile truth, DERIVED here every frame as
 *     `logicalOpen && !isLocked && !isForcedClosed` and stored back on the
 *     component. It drives the tile PASSABLE + TRANSPARENT bits; the FOV system
 *     adapts on the next frame.
 *
 * Decoupling the latch from the derived tile state is what lets a transient
 * safe-room seal close a door's TILE (via effectiveOpen) without destroying its
 * unlock latch — so a shared safe-room / boss-stair door reopens the moment the
 * seal lifts instead of becoming a permanent unlocked-but-closed wall.
 *
 * Must run BEFORE fovSystem each frame.
 */

import { query } from 'bitecs';
import { Companion, DoorState, Player, Position } from '../components.js';
import { evaluateDoorConditionGroup, getDoorLockConfig } from '../door-lock.js';
import { isPointInSafeSpace } from '../safe-space.js';
import { getWorldFloorBehavior } from '../floor-behavior.js';
import type { GameWorld } from '../world.js';

const AUTO_OPEN_RADIUS_TILES = 1;

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function getSafeRoomApproachers(world: GameWorld): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];

  for (const eid of query(world.ecs, [Player, Position])) {
    positions.push({
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
    });
  }

  for (const eid of query(world.ecs, [Companion, Position])) {
    if ((world.stores.companion.knockedOut[eid] ?? 0) !== 0) continue;
    positions.push({
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
    });
  }

  return positions;
}

export function doorSystem(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const doors = query(world.ecs, [DoorState]);
  const { doorState } = world.stores;
  const lockedDoorTiles = new Set<string>();
  const forcedClosedDoorTiles = new Set<string>();
  const safeRoom = floorMap.safeRoom;
  const safeRoomDoorsAutoClose = getWorldFloorBehavior(world).safeRoomDoorsAutoClose;

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
          doorState.logicalOpen[eid] = 1;
        }
      } else if (relockSatisfied) {
        isLocked = true;
        doorState.logicalOpen[eid] = 0;
      }
    }

    doorState.isLocked[eid] = isLocked ? 1 : 0;
    if (isLocked) {
      doorState.logicalOpen[eid] = 0;
      lockedDoorTiles.add(tileKey(tx, ty));
    }
  }

  // Auto-open nearby closed doors so players and companions can traverse room
  // connections. The safe-room seal is allowed to close a door only when no
  // relevant actor remains adjacent to it: every player-owned companion on the
  // threshold counts as still transitioning through the doorway.
  const approvers = getSafeRoomApproachers(world);
  if (safeRoomDoorsAutoClose && safeRoom) {
    const safeRoomActors = approvers.filter((actor) => isPointInSafeSpace(world, actor.x, actor.y));
    if (safeRoomActors.length > 0) {
      const anyDoorTransitionOpen = approvers.some((actor) => {
        const actorTile = floorMap.worldToTile(actor.x, actor.y);
        return safeRoom.doors.some(
          (door) => Math.abs(actorTile.x - door.x) + Math.abs(actorTile.y - door.y) <= 1,
        );
      });
      if (!anyDoorTransitionOpen) {
        for (const door of safeRoom.doors) {
          forcedClosedDoorTiles.add(tileKey(door.x, door.y));
          floorMap.tileMap.closeDoor(door.x, door.y);
        }
      }
    }
  }

  for (const actor of approvers) {
    const px = actor.x;
    const py = actor.y;
    const tile = floorMap.worldToTile(px, py);

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
        if (forcedClosedDoorTiles.has(tileKey(tx, ty))) {
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
    const isForcedClosed = forcedClosedDoorTiles.has(tileKey(tx, ty));
    const isLocked = (doorState.isLocked[eid] ?? 0) !== 0;
    const logicalOpen = (doorState.logicalOpen[eid] ?? 0) !== 0;

    // Derive the physical tile truth from the latch WITHOUT mutating the latch.
    // A lock or a transient safe-room seal (isForcedClosed) closes the TILE
    // only; the logicalOpen latch survives, so the door reopens the moment the
    // lock/seal lifts instead of being permanently clobbered shut.
    const effectiveOpen = logicalOpen && !isLocked && !isForcedClosed;
    doorState.effectiveOpen[eid] = effectiveOpen ? 1 : 0;

    if (effectiveOpen) {
      floorMap.tileMap.openDoor(tx, ty);
    } else {
      floorMap.tileMap.closeDoor(tx, ty);
    }
  }
}
