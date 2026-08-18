/**
 * Boss-encounter telemetry — turns Floor 2 den encounter state into structured
 * diagnostic snapshots.
 *
 * Motivated by a real Floor 2 (seed 42) softlock: the player entered the faerie
 * den, the encounter latched, the doors relocked behind the encounter flag — but
 * the boss had already wandered out of the den. The result was a sealed room
 * with an invisible-but-damageable boss and doors that could only ever reopen on
 * the boss-death latch. None of that was observable in the recorded session,
 * because the session recorder captured only player position/health/quests.
 *
 * These snapshots make that failure mode a single grep (`bossInDen: false` while
 * `started` and `doorsLocked`) instead of a multi-hour source trace.
 *
 * Pure module: no Phaser, no `fs`. Safe to import from labs, the engine bridge,
 * the headless runner, and tests.
 */
import { entityExists, hasComponent } from 'bitecs';
import { DoorState } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import type { BossEncounterSnapshot } from './event-log.js';

/**
 * Build a diagnostic snapshot for every den boss encounter on the current floor.
 *
 * Returns an empty array when the floor has no den encounters (Floor 1, labs
 * without Floor 2 state), so callers can attach the result unconditionally.
 *
 * @param world - Live game world.
 * @param playerEid - Player entity, used to report den occupancy. Pass
 *   `undefined` when there is no player (the `playerInDen` field then reports
 *   `false`).
 */
export function captureBossEncounterSnapshots(
  world: GameWorld,
  playerEid: number | undefined,
): BossEncounterSnapshot[] {
  const encounters = world.floorExtendedState?.familyState?.bossEncounters;
  const floorMap = world.floorMap;
  if (!encounters || encounters.size === 0 || !floorMap) {
    return [];
  }

  let playerRoomId: number | null = null;
  if (playerEid !== undefined) {
    const playerTile = floorMap.worldToTile(
      world.stores.position.x[playerEid] ?? 0,
      world.stores.position.y[playerEid] ?? 0,
    );
    playerRoomId = floorMap.roomGraph.getRoomAt(playerTile.x, playerTile.y);
  }

  const snapshots: BossEncounterSnapshot[] = [];
  for (const encounter of encounters.values()) {
    const bossEid = encounter.bossEid;
    const bossAlive = bossEid !== null && entityExists(world.ecs, bossEid);

    let bossRoomId: number | null = null;
    let bossTileX: number | null = null;
    let bossTileY: number | null = null;
    let bossVisible: boolean | null = null;
    let bossHealth: number | null = null;
    let bossHealthMax: number | null = null;

    if (bossAlive) {
      const tile = floorMap.worldToTile(
        world.stores.position.x[bossEid] ?? 0,
        world.stores.position.y[bossEid] ?? 0,
      );
      bossTileX = tile.x;
      bossTileY = tile.y;
      bossRoomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
      bossVisible = floorMap.isVisible(tile.x, tile.y);
      bossHealth = world.stores.health.current[bossEid] ?? null;
      bossHealthMax = world.stores.health.max[bossEid] ?? null;
    }

    snapshots.push({
      familyId: String(encounter.familyId),
      displayName: encounter.displayName,
      bossEid,
      bossEntityExists: bossAlive,
      started: encounter.started,
      defeated: encounter.defeated,
      denRoomId: encounter.roomId,
      bossRoomId,
      bossInDen: bossRoomId === null ? null : bossRoomId === encounter.roomId,
      bossTileX,
      bossTileY,
      bossHealth,
      bossHealthMax,
      bossVisible,
      activeGoalId: encounter.activeGoalId,
      activeGoalValue: world.goalFlags.get(encounter.activeGoalId) === true,
      doorsLocked: areDoorsLocked(world, encounter.doorEids),
      playerInDen: playerRoomId !== null && playerRoomId === encounter.roomId,
    });
  }
  return snapshots;
}

/** True when any of the den's doors is currently locked shut. */
function areDoorsLocked(world: GameWorld, doorEids: readonly number[]): boolean {
  for (const doorEid of doorEids) {
    if (!entityExists(world.ecs, doorEid) || !hasComponent(world.ecs, doorEid, DoorState)) {
      continue;
    }
    if ((world.stores.doorState.isLocked[doorEid] ?? 0) === 1) {
      return true;
    }
  }
  return false;
}

/**
 * Detect diagnostically interesting transitions between two snapshot sets.
 *
 * Returns human-readable notes for changes worth a discrete `boss` event —
 * encounter start/defeat, the boss entering or leaving its den, and the door
 * lock flipping. Callers emit one event per note so the JSONL stream carries
 * exact frames for each transition rather than only periodic samples.
 */
export function diffBossEncounterSnapshots(
  previous: readonly BossEncounterSnapshot[],
  next: readonly BossEncounterSnapshot[],
): string[] {
  const before = new Map(previous.map((s) => [s.familyId, s]));
  const notes: string[] = [];
  for (const now of next) {
    const was = before.get(now.familyId);
    if (!was) continue;
    if (!was.started && now.started) {
      notes.push(
        `boss encounter started: ${now.familyId} (bossInDen=${String(now.bossInDen)}, denRoom=${now.denRoomId}, bossRoom=${String(now.bossRoomId)})`,
      );
    }
    if (!was.defeated && now.defeated) {
      notes.push(`boss defeated: ${now.familyId}`);
    }
    if (was.bossInDen === true && now.bossInDen === false) {
      notes.push(
        `boss left den: ${now.familyId} (denRoom=${now.denRoomId} -> ${String(now.bossRoomId)})`,
      );
    }
    if (was.bossInDen === false && now.bossInDen === true) {
      notes.push(`boss returned to den: ${now.familyId}`);
    }
    if (was.doorsLocked !== now.doorsLocked) {
      notes.push(
        `den doors ${now.doorsLocked ? 'locked' : 'unlocked'}: ${now.familyId} (playerInDen=${String(now.playerInDen)}, bossInDen=${String(now.bossInDen)})`,
      );
    }
  }
  return notes;
}
